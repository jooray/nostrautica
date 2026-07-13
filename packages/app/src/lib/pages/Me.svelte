<script lang="ts">
  // The hand-off moment (spec §5.4 item 4): "Your Nostr profile is ready."
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import BackupCard from "$lib/components/BackupCard.svelte";
  import NostrichIcon from "$lib/components/NostrichIcon.svelte";

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
  <h1 style="display:flex;align-items:center;gap:0.5rem">
    <span style="color:var(--accent)"><NostrichIcon size={30} /></span>
    You're a Nostr user now
  </h1>
  <p>
    You own a <strong>real Nostr identity</strong> — an account no company controls
    and no one can take away. Your profile and the people you followed travel with
    it into a whole ecosystem of apps.
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
      These are independent Nostr apps — like different clients for the
      <em>same</em> account. Copy your key below, open one, choose “log in with a
      key”, and paste it in — your profile and the people you followed are already
      there.
    </p>
    <BackupCard />
    <div class="stack" style="margin-top:0.75rem">
      {#each clients as c (c.name)}
        <a class="btn" href={c.url} target="_blank" rel="noopener">{c.name} ↗</a>
      {/each}
    </div>
  </div>

  <div class="card">
    <button class="btn danger" onclick={() => session.logout()}>Log out</button>
  </div>
{/if}
