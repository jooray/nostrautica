<script lang="ts">
  import { onMount } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { receiveGrants, isApproved } from "$lib/events/attendee.js";
  import { loadEventKeys } from "$lib/events/keystore.js";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import EventHeader from "$lib/components/EventHeader.svelte";

  let { naddr }: { naddr: string } = $props();

  let ctx = $state<EventContext | null>(cachedEventContext(naddr) ?? null);
  let error = $state<string | null>(null);
  let approved = $state(false);
  let organizer = $state(false);

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      if (session.signer) await receiveGrants(session.signer).catch(() => {});
      approved = await isApproved(ctx.coordinate);
      const keys = await loadEventKeys(ctx.coordinate);
      organizer = keys?.role === "organizer";
      // Remember this event so it shows up under "My events" on Home.
      recentEvents.record({
        coordinate: ctx.coordinate,
        naddr,
        title: ctx.title,
        icon: ctx.icon,
        role: organizer ? "organizer" : approved ? "attendee" : "visitor",
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  function fmt(unix?: number) {
    return unix ? new Date(unix * 1000).toLocaleString() : "";
  }
</script>

{#if error}
  <div class="card warn">
    <strong>Couldn't load this event.</strong>
    <span class="muted">{error}</span>
  </div>
{:else if !ctx}
  <p class="muted">Loading event…</p>
{:else}
  <EventHeader {ctx} />
  <p>{ctx.summary}</p>
  <p class="muted">
    {#if ctx.start}📅 {fmt(ctx.start)}{/if}
    {#if ctx.location}· 📍 {ctx.location}{/if}
  </p>
  <div class="row" style="flex-wrap:wrap">
    <!-- Human labels, not raw config values (UI-SUGGESTIONS #3). -->
    <span class="badge">
      {ctx.config.approval === "invite"
        ? "Invite only"
        : ctx.config.approval === "manual"
          ? "Organizer approval"
          : "Invite or organizer approval"}
    </span>
    {#if ctx.config.matching === "on"}<span class="badge">AI matchmaking</span>{/if}
  </div>

  <div class="card stack">
    {#if organizer}
      <button class="btn primary" onclick={() => router.go({ name: "admin", naddr })}>
        Organizer admin
      </button>
    {/if}
    {#if approved}
      <button class="btn" onclick={() => router.go({ name: "attendees", naddr })}>
        See who's here
      </button>
      {#if ctx.config.matching === "on"}
        <button class="btn primary" onclick={() => router.go({ name: "matches", naddr })}>
          People you should meet
        </button>
      {/if}
      <button class="btn" onclick={() => router.go({ name: "record", naddr, talk: false })}>
        Record / update your intro
      </button>
    {:else}
      <button class="btn primary" onclick={() => router.go({ name: "join", naddr })}>
        Join this event
      </button>
      <p class="muted">
        You'll be approved by the organizer (or instantly with an invite link).
      </p>
    {/if}
  </div>
{/if}
