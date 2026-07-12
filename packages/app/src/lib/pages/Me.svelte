<script lang="ts">
  // The hand-off moment (spec §5.4 item 4): "Your Nostr profile is ready."
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import BackupCard from "$lib/components/BackupCard.svelte";

  const clients = [
    { name: "Primal", url: "https://primal.net" },
    { name: "Damus", url: "https://damus.io" },
    { name: "Amethyst", url: "https://github.com/vitorpamplona/amethyst" },
    { name: "Yakihonne", url: "https://yakihonne.com" },
  ];

  let copied = $state(false);
  async function copyNpub() {
    if (!session.npub) return;
    await navigator.clipboard.writeText(session.npub);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

{#if !session.loggedIn}
  <div class="card">
    <p>You're not logged in.</p>
    <button class="btn primary" onclick={() => router.go({ name: "login" })}>Log in</button>
  </div>
{:else}
  <h1>Your Nostr profile is ready</h1>
  <p class="muted">
    You own a portable identity now. Paste your key into any of these apps and
    you'll instantly see posts from the people you followed at events.
  </p>

  <div class="card">
    <div class="field-label">Your public key (npub)</div>
    <p class="mono">{session.npub}</p>
    <button class="btn inline" onclick={copyNpub}>{copied ? "Copied ✓" : "Copy npub"}</button>
    <p class="muted" style="margin-top:0.5rem">Signed in via {session.signer?.method}.</p>
  </div>

  <div class="card">
    <h2>Take it anywhere</h2>
    <div class="stack">
      {#each clients as c (c.name)}
        <a class="btn" href={c.url} target="_blank" rel="noopener">{c.name} ↗</a>
      {/each}
    </div>
  </div>

  <div class="card">
    <h2>Back up your key</h2>
    <BackupCard />
  </div>

  <div class="card">
    <button class="btn danger" onclick={() => session.logout()}>Log out</button>
  </div>
{/if}
