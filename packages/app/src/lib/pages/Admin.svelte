<script lang="ts">
  import { onMount } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, type EventContext } from "$lib/events/event-context.js";
  import { loadEventKeys, type EventKeys } from "$lib/events/keystore.js";
  import {
    fetchPending,
    approveAttendee,
    type PendingRequest,
  } from "$lib/events/organizer.js";

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

  async function approve(req: PendingRequest) {
    if (!ctx || !session.signer) return;
    try {
      await approveAttendee(session.signer, ctx, req);
      approvedSet = new Set([...approvedSet, req.attendeePubkey]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function short(pk: string) {
    return pk.slice(0, 8) + "…" + pk.slice(-4);
  }
</script>

<h1>Organizer admin</h1>

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
        {#if approvedSet.has(req.attendeePubkey)}
          <p class="muted">Approved ✓</p>
        {:else}
          <button class="btn primary" onclick={() => approve(req)}>Approve</button>
        {/if}
      </div>
    {/each}
  </div>
{/if}
