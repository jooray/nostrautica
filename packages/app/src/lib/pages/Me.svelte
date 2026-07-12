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
  <h1>🎉 You're a Nostr user now</h1>
  <p>
    Without doing anything crypto-y, you've created a <strong>real Nostr identity</strong> —
    an account you fully own that isn't tied to this app or any company. It works
    across a whole ecosystem of social apps, and no one can lock you out of it or
    take it away.
  </p>
  <p class="muted">
    The people you followed here, your profile, your posts — they all travel with
    that identity. "Take it anywhere" is literal: open one of the apps below,
    paste in your key, and you'll instantly see the feed of everyone you met.
  </p>

  <div class="card">
    <div class="field-label">Your public handle (npub)</div>
    <p class="muted" style="margin:0 0 0.25rem">
      Share this freely — it's how people find and follow you. (It's safe to post.)
    </p>
    <p class="mono">{session.npub}</p>
    <button class="btn inline" onclick={copyNpub}>{copied ? "Copied ✓" : "Copy npub"}</button>
    <p class="muted" style="margin-top:0.5rem">Signed in via {session.signer?.method}.</p>
  </div>

  <div class="card">
    <h2>Take it anywhere</h2>
    <p class="muted">
      These are independent Nostr apps — like different Twitter/Instagram clients
      for the <em>same</em> account. To log into any of them, you use your secret
      key (your <strong>nsec</strong>, from “Back up your key” below) — that's the
      private half that proves the account is yours, so keep it secret.
    </p>
    <ol class="muted" style="margin:0.5rem 0 0.75rem;padding-left:1.2rem">
      <li>Copy your nsec from the backup section below.</li>
      <li>Open one of these apps and choose “log in with a key / nsec”.</li>
      <li>Paste it in — your profile and the people you followed are already there.</li>
    </ol>
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
