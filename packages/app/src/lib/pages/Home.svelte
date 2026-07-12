<script lang="ts">
  import { onMount } from "svelte";
  import { coordinateToNaddr, parseCoordinate } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { listEventKeys } from "$lib/events/keystore.js";
  import { defaultEventIcon } from "$lib/media/image.js";

  const events = $derived(recentEvents.list);
  const roleLabel = { organizer: "you organize", attendee: "joined", visitor: "viewed" };

  /** A readable placeholder title from a coordinate's identifier. */
  function placeholderTitle(coordinate: string): string {
    let id = "event";
    try {
      id = parseCoordinate(coordinate).identifier;
    } catch {
      /* keep default */
    }
    return id
      .replace(/-[0-9a-f]{6,}$/i, "") // strip the random slug suffix
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || "Event";
  }

  // Backfill "My events" from the local key store — every event the user created
  // or was approved into — so events created before this list existed still show.
  onMount(async () => {
    const keys = await listEventKeys().catch(() => []);
    for (const k of keys) {
      if (recentEvents.has(k.coordinate)) continue;
      recentEvents.record({
        coordinate: k.coordinate,
        naddr: coordinateToNaddr(k.coordinate),
        title: placeholderTitle(k.coordinate),
        role: k.role,
        at: 1, // backfill without bumping to the top
      });
    }
  });
</script>

<h1>Meet the right people</h1>
<p class="muted">
  Nostrautica figures out who you should meet at an event — and explains why —
  from short intro videos and your public Nostr activity.
</p>

{#if events.length}
  <h2>Your events</h2>
  <div class="stack">
    {#each events as e (e.naddr)}
      <button
        class="card row"
        style="text-align:left;cursor:pointer;gap:0.75rem;align-items:center"
        onclick={() => router.go({ name: "event", naddr: e.naddr })}
      >
        <img
          src={e.icon || defaultEventIcon(e.title, e.title)}
          alt=""
          width="44"
          height="44"
          style="border-radius:11px;flex:none"
        />
        <div style="flex:1;min-width:0">
          <strong style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            {e.title}
          </strong>
          <span class="badge">{roleLabel[e.role]}</span>
        </div>
        <span class="muted">›</span>
      </button>
    {/each}
  </div>
  <button class="btn" style="margin-top:0.5rem" onclick={() => router.go({ name: "create" })}>
    ＋ Create another event
  </button>
{:else if !session.loggedIn}
  <div class="card">
    <h2>Get started</h2>
    <p class="muted">Open an event invite link, or create your own.</p>
    <button class="btn primary" onclick={() => router.go({ name: "login" })}>
      Log in or create an identity
    </button>
    <button class="btn" style="margin-top:0.5rem" onclick={() => router.go({ name: "create" })}>
      Create an event
    </button>
  </div>
{:else}
  <div class="card">
    <h2>No events yet</h2>
    <p class="muted">Open an invite link to join an event, or create your own.</p>
    <button class="btn primary" onclick={() => router.go({ name: "create" })}>
      Create an event
    </button>
  </div>
{/if}

<div class="card">
  <h2>How it works</h2>
  <ul class="muted">
    <li>Record a short intro video (and optionally a talk).</li>
    <li>Get matched with people whose skills complement yours.</li>
    <li>Everything's encrypted to the event's attendees.</li>
    <li>Leave with a real, portable Nostr profile.</li>
  </ul>
</div>
