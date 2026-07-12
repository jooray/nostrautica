<script lang="ts">
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
</script>

<h1>Meet the right people</h1>
<p class="muted">
  Nostrautica figures out who you should meet at an event — and explains why —
  from short intro videos and your public Nostr activity.
</p>

{#if !session.loggedIn}
  <div class="card">
    <h2>Get started</h2>
    <button class="btn primary" onclick={() => router.go({ name: "login" })}>
      Log in or create an identity
    </button>
  </div>
{:else}
  <div class="card">
    <h2>Your events</h2>
    <p class="muted">
      Open an event link to join, or create your own event.
    </p>
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
