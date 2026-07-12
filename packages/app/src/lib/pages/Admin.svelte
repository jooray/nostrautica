<script lang="ts">
  import { onMount } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, type EventContext } from "$lib/events/event-context.js";
  import { loadEventKeys, type EventKeys } from "$lib/events/keystore.js";
  import {
    fetchPending,
    approveAttendee,
    attachCoordinator,
    generateInvites,
    revokeAttendeeClient,
    sendAdminCommand,
    addCoOrganizer,
    type PendingRequest,
    type GeneratedInvite,
  } from "$lib/events/organizer.js";
  import { decode } from "nostr-tools/nip19";
  import QrCode from "$lib/components/QrCode.svelte";
  import EventHeader from "$lib/components/EventHeader.svelte";
  import { router } from "$lib/router/router.svelte.js";

  let { naddr }: { naddr: string } = $props();

  let ctx = $state<EventContext | null>(null);
  let keys = $state<EventKeys | null>(null);
  let pending = $state<PendingRequest[]>([]);
  let approvedSet = $state<Set<string>>(new Set());
  let loading = $state(true);
  let error = $state<string | null>(null);
  let notOrganizer = $state(false);

  async function refresh() {
    if (!ctx || !keys) return;
    pending = await fetchPending(ctx, keys);
  }

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      keys = (await loadEventKeys(ctx.coordinate)) ?? null;
      if (!keys || keys.role !== "organizer") {
        notOrganizer = true;
        return;
      }
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  });

  let coordinatorInput = $state("");
  let attaching = $state(false);
  let attached = $state(false);

  async function attach() {
    if (!ctx || !session.signer || !coordinatorInput.trim()) return;
    attaching = true;
    error = null;
    try {
      let pubkey = coordinatorInput.trim();
      if (pubkey.startsWith("npub1")) {
        const decoded = decode(pubkey);
        if (decoded.type !== "npub") throw new Error("bad npub");
        pubkey = decoded.data;
      }
      if (!/^[0-9a-f]{64}$/i.test(pubkey)) throw new Error("Enter an npub or 64-char hex pubkey");
      await attachCoordinator(session.signer, ctx, pubkey);
      attached = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      attaching = false;
    }
  }

  let coOrgInput = $state("");
  let addingCoOrg = $state(false);
  let coOrgAdded = $state(false);
  async function addCoOrg() {
    if (!ctx || !session.signer || !coOrgInput.trim()) return;
    addingCoOrg = true;
    error = null;
    try {
      let pubkey = coOrgInput.trim();
      if (pubkey.startsWith("npub1")) {
        const decoded = decode(pubkey);
        if (decoded.type !== "npub") throw new Error("bad npub");
        pubkey = decoded.data;
      }
      if (!/^[0-9a-f]{64}$/i.test(pubkey)) throw new Error("Enter an npub or 64-char hex pubkey");
      await addCoOrganizer(session.signer, ctx, pubkey);
      coOrgAdded = true;
      coOrgInput = "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      addingCoOrg = false;
    }
  }

  let inviteCount = $state(5);
  let invites = $state<GeneratedInvite[]>([]);
  let generating = $state(false);

  async function makeInvites() {
    if (!ctx || !session.signer) return;
    generating = true;
    error = null;
    try {
      const base = window.location.origin + window.location.pathname;
      invites = await generateInvites(session.signer, ctx, inviteCount, base);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      generating = false;
    }
  }

  async function copyLink(link: string) {
    await navigator.clipboard.writeText(link);
  }

  let recomputing = $state(false);
  async function recomputeMatches() {
    if (!ctx?.config.coordinator) return;
    recomputing = true;
    error = null;
    try {
      await sendAdminCommand(ctx, "recompute");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      recomputing = false;
    }
  }

  async function reprocess(req: PendingRequest) {
    if (!ctx || !session.signer) return;
    try {
      if (ctx.config.coordinator) {
        await sendAdminCommand(ctx, "reprocess", { pubkey: req.attendeePubkey });
      } else {
        await approveAttendee(session.signer, ctx, req); // re-publishes the entry
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function approve(req: PendingRequest) {
    if (!ctx || !session.signer) return;
    try {
      if (ctx.config.coordinator) {
        // Route through the coordinator so IT grants + publishes the directory
        // (attendees discover directory/roster/matches under the coordinator key).
        await sendAdminCommand(ctx, "approve", { pubkey: req.attendeePubkey });
      } else {
        await approveAttendee(session.signer, ctx, req);
      }
      approvedSet = new Set([...approvedSet, req.attendeePubkey]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  let revokedSet = $state<Set<string>>(new Set());
  async function revoke(req: PendingRequest) {
    if (!ctx || !session.signer) return;
    if (!confirm(`Revoke ${req.name}? This rotates the event key (forward-only).`)) return;
    try {
      if (ctx.config.coordinator) {
        await sendAdminCommand(ctx, "revoke", { pubkey: req.attendeePubkey });
      } else {
        await revokeAttendeeClient(session.signer, ctx, req.attendeePubkey);
      }
      revokedSet = new Set([...revokedSet, req.attendeePubkey]);
      approvedSet = new Set([...approvedSet].filter((p) => p !== req.attendeePubkey));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function short(pk: string) {
    return pk.slice(0, 8) + "…" + pk.slice(-4);
  }
</script>

{#if ctx}
  <EventHeader {ctx} compact link />
{/if}
<div class="row" style="justify-content:space-between;align-items:center">
  <h1 style="margin:0">Organizer admin</h1>
  {#if ctx}
    <button class="btn inline" onclick={() => router.go({ name: "event", naddr })}>
      Done ✓
    </button>
  {/if}
</div>

{#if error}<div class="card warn">{error}</div>{/if}

{#if notOrganizer}
  <div class="card">
    <p>You don't hold this event's organizer keys on this device.</p>
  </div>
{:else if loading}
  <p class="muted">Loading pending requests…</p>
{:else}
  <div class="row" style="justify-content:space-between">
    <p class="muted">{pending.length} join request{pending.length === 1 ? "" : "s"}</p>
    <button class="btn inline" onclick={refresh}>Refresh</button>
  </div>

  <div class="card">
    <div class="field-label">AI coordinator</div>
    {#if ctx?.config.coordinator}
      <p class="muted">Attached: <span class="mono">{ctx.config.coordinator.slice(0, 16)}…</span></p>
      <button class="btn inline" onclick={recomputeMatches} disabled={recomputing}>
        {recomputing ? "Recomputing…" : "↻ Recompute all matches"}
      </button>
    {:else if attached}
      <p class="muted">Coordinator attached ✓ Matchmaking will begin as attendees are processed.</p>
    {:else}
      <p class="muted">
        Paste the coordinator's npub to enable AI matchmaking. It can read
        event-encrypted content but cannot impersonate the event (spec §4.2).
      </p>
      <input placeholder="npub1… (coordinator)" bind:value={coordinatorInput} />
      <button class="btn" style="margin-top:0.5rem" onclick={attach} disabled={attaching}>
        {attaching ? "Attaching…" : "Attach coordinator"}
      </button>
    {/if}
  </div>

  <div class="card">
    <div class="field-label">Co-organizers</div>
    <p class="muted">
      Add someone by their npub to share full organizer control — they can edit the
      event, approve attendees, and manage the coordinator. (Their keys are
      gift-wrapped to them; they'll get access next time they open the event.)
    </p>
    <input placeholder="npub1… (co-organizer)" bind:value={coOrgInput} />
    <div class="row" style="margin-top:0.5rem">
      <button class="btn inline" onclick={addCoOrg} disabled={addingCoOrg || !coOrgInput.trim()}>
        {addingCoOrg ? "Adding…" : "Add co-organizer"}
      </button>
      {#if coOrgAdded}<span class="muted">Sent ✓</span>{/if}
    </div>
  </div>

  <div class="card">
    <div class="field-label">Invite codes</div>
    <p class="muted">
      Single-use links that auto-approve (with a coordinator). The code rides the
      URL fragment and never touches a server.
    </p>
    <div class="row">
      <input type="number" min="1" max="100" bind:value={inviteCount} style="max-width:5rem" />
      <button class="btn inline" onclick={makeInvites} disabled={generating}>
        {generating ? "Generating…" : "Generate"}
      </button>
    </div>
    {#each invites as inv (inv.nsec)}
      <div class="card" style="background:var(--bg-elev2)">
        <div class="row" style="justify-content:space-between">
          <span class="badge">{inv.label}</span>
          <button class="btn inline" onclick={() => copyLink(inv.link)}>Copy link</button>
        </div>
        <QrCode data={inv.link} size={140} />
        <p class="mono">{inv.link}</p>
      </div>
    {/each}
  </div>

  {#if ctx}
    <p class="muted">
      Invite link: <span class="mono"
        >{typeof window !== "undefined"
          ? window.location.origin + window.location.pathname
          : ""}#/e/{naddr}/join</span
      >
    </p>
  {/if}

  <div class="stack">
    {#each pending as req (req.attendeePubkey)}
      <div class="card">
        <strong>{req.name}</strong>
        <span class="badge">{short(req.attendeePubkey)}</span>
        {#if req.invite}<span class="badge">invite</span>{/if}
        {#if req.message}<p class="muted">{req.message}</p>{/if}
        {#if req.profile?.skills?.length}
          <div class="row" style="flex-wrap:wrap">
            {#each req.profile.skills as s (s)}<span class="badge">{s}</span>{/each}
          </div>
        {/if}
        {#if req.media?.length}<span class="badge">🎥 {req.media.length} video</span>{/if}
        {#if revokedSet.has(req.attendeePubkey)}
          <p class="muted">Revoked ✓ (event key rotated)</p>
        {:else if approvedSet.has(req.attendeePubkey)}
          <p class="muted">Approved ✓</p>
          <div class="row">
            <button class="btn inline" onclick={() => reprocess(req)}>Re-process</button>
            <button class="btn inline danger" onclick={() => revoke(req)}>Revoke</button>
          </div>
        {:else}
          <button class="btn primary" onclick={() => approve(req)}>Approve</button>
        {/if}
      </div>
    {/each}
  </div>
{/if}
