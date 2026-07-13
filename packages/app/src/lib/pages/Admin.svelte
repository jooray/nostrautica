<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { loadEventKeys, type EventKeys } from "$lib/events/keystore.js";
  import { fetchRoster, receiveGrants } from "$lib/events/attendee.js";
  import {
    fetchPending,
    approveAttendee,
    attachCoordinator,
    fetchCoordinatorLastSeen,
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
  import {
    fetchEventUpdates,
    publishEventUpdate,
    type EventUpdate,
  } from "$lib/events/updates.js";
  import { t, tp } from "$lib/i18n/i18n.svelte.js";

  let { naddr }: { naddr: string } = $props();

  let ctx = $state<EventContext | null>(cachedEventContext(naddr) ?? null);
  let keys = $state<EventKeys | null>(null);
  let pending = $state<PendingRequest[]>([]);
  let approvedSet = $state<Set<string>>(new Set()); // approved this session
  let rosterApproved = $state<Set<string>>(new Set()); // approved per the roster
  let loading = $state(true);
  let error = $state<string | null>(null);
  let notOrganizer = $state(false);
  let copiedLink = $state(false);
  let copiedNpub = $state(false);
  let coordLastSeen = $state<number | undefined>(undefined);
  let destroyed = false;
  onDestroy(() => (destroyed = true));

  // Approved = anyone in the roster OR approved just now. Reading the roster makes
  // approval persist across refreshes (it's not just session state).
  function isApprovedNow(pubkey: string): boolean {
    return approvedSet.has(pubkey) || rosterApproved.has(pubkey);
  }
  const pendingRequests = $derived(
    pending.filter((p) => !isApprovedNow(p.attendeePubkey)),
  );
  const approvedRequests = $derived(
    pending.filter((p) => isApprovedNow(p.attendeePubkey)),
  );

  async function refresh() {
    if (!ctx || !keys) return;
    pending = await fetchPending(ctx, keys);
    // Cross-reference the roster so already-approved attendees don't show as pending.
    const roster = await fetchRoster(ctx).catch(() => undefined);
    rosterApproved = new Set(roster?.attendees.map((a) => a.pubkey) ?? []);
  }

  function scrollToRequests() {
    document.getElementById("join-requests")?.scrollIntoView({ behavior: "smooth" });
  }

  async function copyInviteLink() {
    const link = `${window.location.origin}${window.location.pathname}#/e/${naddr}/join`;
    await navigator.clipboard.writeText(link);
    copiedLink = true;
    setTimeout(() => (copiedLink = false), 1500);
  }

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      keys = (await loadEventKeys(ctx.coordinate)) ?? null;
      if (!keys || keys.role !== "organizer") {
        notOrganizer = true;
        // The organizer keys may arrive as a 21605 grant (co-organizer / hand-off
        // to another device) — poll while the page is open so it unlocks without a
        // manual reload (P2 recovery path). Same receiveGrants channel the app uses.
        void pollForOrganizerGrant();
        return;
      }
      await refresh();
      await loadUpdates();
      void refreshLiveness();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  });

  async function pollForOrganizerGrant() {
    if (!ctx || !session.signer) return;
    while (notOrganizer && !destroyed) {
      await new Promise((r) => setTimeout(r, 4000));
      if (destroyed) return;
      await receiveGrants(session.signer).catch(() => {});
      const k = await loadEventKeys(ctx.coordinate);
      if (k && k.role === "organizer") {
        keys = k;
        notOrganizer = false;
        loading = true;
        try {
          await refresh();
          await loadUpdates();
          void refreshLiveness();
        } finally {
          loading = false;
        }
        return;
      }
    }
  }

  async function refreshLiveness() {
    if (!ctx?.config.coordinator) return;
    coordLastSeen = await fetchCoordinatorLastSeen(ctx).catch(() => undefined);
  }

  // Human "active 2 min ago" from a unix seconds timestamp.
  function sinceLabel(unixSec: number): string {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
    if (s < 90) return t("admin.coord.justNow");
    if (s < 3600) return t("admin.coord.minAgo", { n: Math.round(s / 60) });
    if (s < 86400) return t("admin.coord.hAgo", { n: Math.round(s / 3600) });
    return t("admin.coord.dAgo", { n: Math.round(s / 86400) });
  }
  const coordStale = $derived(
    coordLastSeen !== undefined &&
      Math.floor(Date.now() / 1000) - coordLastSeen > 3600,
  );

  async function copyMyNpub() {
    if (!session.npub) return;
    await navigator.clipboard.writeText(session.npub);
    copiedNpub = true;
    setTimeout(() => (copiedNpub = false), 1500);
  }

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
        if (decoded.type !== "npub") throw new Error(t("admin.error.badNpub"));
        pubkey = decoded.data;
      }
      if (!/^[0-9a-f]{64}$/i.test(pubkey)) throw new Error(t("admin.error.enterNpub"));
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
        if (decoded.type !== "npub") throw new Error(t("admin.error.badNpub"));
        pubkey = decoded.data;
      }
      if (!/^[0-9a-f]{64}$/i.test(pubkey)) throw new Error(t("admin.error.enterNpub"));
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

  let approvingAll = $state(false);
  async function approveAll() {
    approvingAll = true;
    try {
      for (const req of pendingRequests) await approve(req);
    } finally {
      approvingAll = false;
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
  // Inline, screenshotable revoke confirmation (no window.confirm) — the attendee
  // card swaps to the consequence copy + Revoke/Keep while this holds a pubkey.
  let confirmingRevoke = $state<string | null>(null);
  async function revoke(req: PendingRequest) {
    if (!ctx || !session.signer) return;
    confirmingRevoke = null;
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

  // Event updates (spec §7.1 kind 30023): publish/edit announcements as E_id.
  let updates = $state<EventUpdate[]>([]);
  let updTitle = $state("");
  let updContent = $state("");
  let updEditing = $state<EventUpdate | null>(null); // null = new update
  let updBusy = $state(false);

  async function loadUpdates() {
    if (!ctx) return;
    updates = await fetchEventUpdates(ctx.coordinate).catch(() => []);
  }

  function startEdit(u: EventUpdate) {
    updEditing = u;
    updTitle = u.title;
    updContent = u.content;
  }

  async function publishUpdate() {
    if (!ctx || !updTitle.trim() || !updContent.trim()) return;
    updBusy = true;
    error = null;
    try {
      await publishEventUpdate(ctx, {
        d: updEditing?.d,
        publishedAt: updEditing?.publishedAt,
        title: updTitle.trim(),
        content: updContent,
      });
      updTitle = "";
      updContent = "";
      updEditing = null;
      await loadUpdates();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      updBusy = false;
    }
  }
</script>

{#if ctx}
  <EventHeader {ctx} compact link />
{/if}
<div class="row" style="justify-content:space-between;align-items:center">
  <h1 style="margin:0">{t("admin.title")}</h1>
  {#if ctx}
    <button class="btn inline" onclick={() => router.go({ name: "event", naddr })}>
      {t("admin.done")}
    </button>
  {/if}
</div>

{#if error}<div class="card warn">{error}</div>{/if}

{#if notOrganizer}
  <div class="card">
    <p><strong>{t("admin.notOrganizer.title")}</strong></p>
    <p class="muted">
      {t("admin.notOrganizer.body")}
    </p>
    <div class="field-label">{t("admin.yourNpub")}</div>
    <p class="mono">{session.npub}</p>
    <button class="btn inline" onclick={copyMyNpub}>
      {copiedNpub ? t("admin.copied") : t("admin.copyNpub")}
    </button>
    <ol class="muted" style="margin:0.75rem 0 0;padding-left:1.25rem">
      <li>{t("admin.grant.step1")}</li>
      <li>{t("admin.grant.step2")}</li>
      <li>{t("admin.grant.step3")}</li>
    </ol>
    <p class="muted" style="margin-top:0.5rem">{t("admin.grant.waiting")}</p>
  </div>
{:else if loading}
  <p class="muted">{t("admin.loading")}</p>
{:else}
  <div class="row" style="justify-content:space-between">
    <button
      class="btn inline"
      onclick={scrollToRequests}
      disabled={pendingRequests.length === 0}
    >
      {tp("admin.pending", pendingRequests.length)}
    </button>
    <button class="btn inline" onclick={refresh}>{t("admin.refresh")}</button>
  </div>

  <div class="card">
    <div class="field-label">{t("admin.updates.title")}</div>
    <p class="muted">
      {t("admin.updates.body")}
    </p>
    <input placeholder={t("admin.updates.titlePlaceholder")} bind:value={updTitle} />
    <textarea
      rows="4"
      placeholder={t("admin.updates.contentPlaceholder")}
      bind:value={updContent}
      style="margin-top:0.5rem"
    ></textarea>
    <div class="row" style="margin-top:0.5rem">
      <button
        class="btn inline primary"
        onclick={publishUpdate}
        disabled={updBusy || !updTitle.trim() || !updContent.trim()}
      >
        {updBusy ? t("admin.updates.publishing") : updEditing ? t("admin.updates.saveEdit") : t("admin.updates.publish")}
      </button>
      {#if updEditing}
        <button
          class="btn inline"
          onclick={() => {
            updEditing = null;
            updTitle = "";
            updContent = "";
          }}
        >
          {t("admin.updates.cancelEdit")}
        </button>
      {/if}
    </div>
    {#if updates.length}
      <div class="stack" style="margin-top:0.75rem">
        {#each updates as u (u.d)}
          <div class="row" style="justify-content:space-between">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              {u.title}
              <span class="muted" style="font-size:0.75rem">
                · {new Date(u.publishedAt * 1000).toLocaleDateString()}
              </span>
            </span>
            <button class="btn inline" style="flex:none" onclick={() => startEdit(u)}>
              {t("admin.updates.edit")}
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="card">
    <div class="field-label">{t("admin.coordinator.title")}</div>
    {#if ctx?.config.coordinator}
      <p class="muted">{t("admin.coordinator.attached")} <span class="mono">{ctx.config.coordinator.slice(0, 16)}…</span></p>
      <p class="muted" style="margin:0 0 0.5rem">
        {#if coordLastSeen === undefined}
          <span class="badge" class:warn={coordStale}>{t("admin.coordinator.noActivity")}</span>
        {:else}
          <span class="badge" class:warn={coordStale}>{sinceLabel(coordLastSeen)}</span>
        {/if}
        {#if coordStale}
          <span style="color:var(--danger)">{t("admin.coordinator.stale")}</span>
        {/if}
      </p>
      <button class="btn inline" onclick={recomputeMatches} disabled={recomputing}>
        {recomputing ? t("admin.coordinator.recomputing") : t("admin.coordinator.recompute")}
      </button>
    {:else if attached}
      <p class="muted">{t("admin.coordinator.attachedOk")}</p>
    {:else}
      <p class="muted">
        {t("admin.coordinator.body")}
      </p>
      <input placeholder={t("admin.coordinator.placeholder")} bind:value={coordinatorInput} />
      <button class="btn" style="margin-top:0.5rem" onclick={attach} disabled={attaching}>
        {attaching ? t("admin.coordinator.attaching") : t("admin.coordinator.attach")}
      </button>
    {/if}
  </div>

  <div class="card">
    <div class="field-label">{t("admin.coorg.title")}</div>
    <p class="muted">
      {t("admin.coorg.body")}
    </p>
    <input placeholder={t("admin.coorg.placeholder")} bind:value={coOrgInput} />
    <div class="row" style="margin-top:0.5rem">
      <button class="btn inline" onclick={addCoOrg} disabled={addingCoOrg || !coOrgInput.trim()}>
        {addingCoOrg ? t("admin.coorg.adding") : t("admin.coorg.add")}
      </button>
      {#if coOrgAdded}<span class="muted">{t("admin.coorg.sent")}</span>{/if}
    </div>
  </div>

  <div class="card">
    <div class="field-label">{t("admin.invites.title")}</div>
    <p class="muted">
      {t("admin.invites.body")}
    </p>
    <div class="row">
      <input type="number" min="1" max="100" bind:value={inviteCount} style="max-width:5rem" />
      <button class="btn inline" onclick={makeInvites} disabled={generating}>
        {generating ? t("admin.invites.generating") : t("admin.invites.generate")}
      </button>
    </div>
    {#each invites as inv (inv.nsec)}
      <div class="card" style="background:var(--bg-elev2)">
        <div class="row" style="justify-content:space-between">
          <span class="badge">{inv.label}</span>
          <button class="btn inline" onclick={() => copyLink(inv.link)}>{t("admin.invites.copyLink")}</button>
        </div>
        <QrCode data={inv.link} size={140} />
        <p class="mono">{inv.link}</p>
      </div>
    {/each}
  </div>

  {#if ctx}
    <div class="row" style="justify-content:space-between;gap:0.5rem">
      <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
        >{window.location.origin + window.location.pathname}#/e/{naddr}/join</span
      >
      <button class="btn inline" style="flex:none" onclick={copyInviteLink}>
        {copiedLink ? t("admin.inviteLink.copied") : t("admin.inviteLink.copy")}
      </button>
      {#if typeof navigator !== "undefined" && navigator.share}
        <button
          class="btn inline"
          style="flex:none"
          onclick={() =>
            navigator
              .share({
                title: ctx?.title,
                url: `${window.location.origin}${window.location.pathname}#/e/${naddr}/join`,
              })
              .catch(() => {})}
        >
          {t("admin.share")}
        </button>
      {/if}
    </div>
  {/if}

  <h2 id="join-requests">{t("admin.requests.title")}</h2>
  <div class="stack">
    {#if pendingRequests.length === 0}
      <p class="muted">{t("admin.requests.none")}</p>
    {:else if pendingRequests.length > 1}
      <button class="btn" onclick={approveAll} disabled={approvingAll}>
        {approvingAll ? t("admin.requests.approving") : t("admin.requests.approveAll", { n: pendingRequests.length })}
      </button>
    {/if}
    {#each pendingRequests as req (req.attendeePubkey)}
      <div class="card">
        <strong>{req.name}</strong>
        <span class="badge">{short(req.attendeePubkey)}</span>
        {#if req.invite}<span class="badge">{t("admin.requests.invite")}</span>{/if}
        {#if req.message}<p class="muted">{req.message}</p>{/if}
        {#if req.profile?.skills?.length}
          <div class="row" style="flex-wrap:wrap">
            {#each req.profile.skills as s (s)}<span class="badge">{s}</span>{/each}
          </div>
        {/if}
        {#if req.media?.length}<span class="badge">{tp("admin.requests.video", req.media.length)}</span>{/if}
        <button class="btn primary" onclick={() => approve(req)}>{t("admin.requests.approve")}</button>
      </div>
    {/each}
  </div>

  {#if approvedRequests.length}
    <h2>{t("admin.approved.title", { n: approvedRequests.length })}</h2>
    <div class="stack">
      {#each approvedRequests as req (req.attendeePubkey)}
        <div class="card">
          <strong>{req.name}</strong>
          <span class="badge">{short(req.attendeePubkey)}</span>
          {#if req.media?.length}<span class="badge">{tp("admin.requests.video", req.media.length)}</span>{/if}
          {#if revokedSet.has(req.attendeePubkey)}
            <p class="muted">{t("admin.revoked")}</p>
          {:else if confirmingRevoke === req.attendeePubkey}
            <p class="muted" style="margin:0.25rem 0">
              {t("admin.revoke.confirm")}
            </p>
            <div class="row">
              <button class="btn inline danger" onclick={() => revoke(req)}>{t("admin.revoke.revoke")}</button>
              <button class="btn inline" onclick={() => (confirmingRevoke = null)}>{t("admin.revoke.keep")}</button>
            </div>
          {:else}
            <p class="muted">{t("admin.approvedTag")}</p>
            <div class="row">
              <button class="btn inline" onclick={() => reprocess(req)}>{t("admin.reprocess")}</button>
              <button
                class="btn inline danger"
                onclick={() => (confirmingRevoke = req.attendeePubkey)}
              >
                {t("admin.revoke.revoke")}
              </button>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
{/if}
