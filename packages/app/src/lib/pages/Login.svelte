<script lang="ts">
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { hasNip07 } from "$lib/signer/nip07.js";
  import { Nip46Signer, type NostrConnectHandle } from "$lib/signer/nip46.js";
  import { DEFAULT_RELAYS } from "$lib/nostr/relays.js";
  import BackupCard from "$lib/components/BackupCard.svelte";
  import QrCode from "$lib/components/QrCode.svelte";

  let error = $state<string | null>(null);
  let busy = $state(false);
  let nc = $state<NostrConnectHandle | null>(null);

  // Paste-to-import (nsec / ncryptsec / hex)
  let pasteKey = $state("");
  let pastePw = $state("");

  async function run(fn: () => Promise<void>) {
    error = null;
    busy = true;
    try {
      await fn();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const loginNip07 = () =>
    run(async () => {
      await session.loginNip07();
      done();
    });

  const startNostrConnect = () =>
    run(async () => {
      nc = Nip46Signer.startNostrConnect(DEFAULT_RELAYS);
      const signer = await nc.connected;
      await session.loginNip46(signer);
      nc = null;
      done();
    });

  const pasteBunker = () =>
    run(async () => {
      const signer = await Nip46Signer.fromBunkerUri(pasteKey.trim());
      await session.loginNip46(signer);
      done();
    });

  const createLocal = () =>
    run(async () => {
      await session.createLocalKey();
      // Stay on this page so the freshly-generated key's backup card shows.
    });

  const importLocal = () =>
    run(async () => {
      await session.importLocalKey(pasteKey.trim(), pastePw || undefined);
      done();
    });

  function done() {
    router.go({ name: "home" });
  }

  const looksLikeBunker = $derived(pasteKey.trim().startsWith("bunker://"));
</script>

<h1>Log in</h1>

{#if session.loggedIn && session.freshLocalKey}
  <div class="card">
    <h2>You're in 🎉</h2>
    <p class="muted">
      A Nostr identity was just created for you. Back it up now so you never lose
      access.
    </p>
    <BackupCard />
    <button class="btn primary" onclick={done} style="margin-top:0.75rem">
      Continue
    </button>
  </div>
{:else if session.loggedIn}
  <div class="card">
    <p>You're already logged in.</p>
    <button class="btn primary" onclick={done}>Continue</button>
  </div>
{:else}
  {#if error}
    <div class="card warn"><strong>Couldn't log in.</strong> {error}</div>
  {/if}

  <div class="card">
    <h2>New here?</h2>
    <p class="muted">
      Just start — we'll create an identity for you. No password, no jargon.
    </p>
    <button class="btn primary" onclick={createLocal} disabled={busy}>
      Create an identity
    </button>
  </div>

  {#if hasNip07()}
    <div class="card">
      <h2>Browser extension</h2>
      <p class="muted">Log in with your NIP-07 signer (Alby, nos2x…).</p>
      <button class="btn" onclick={loginNip07} disabled={busy}>
        Use browser extension
      </button>
    </div>
  {/if}

  <div class="card">
    <h2>Remote signer (Amber)</h2>
    <p class="muted">Scan this with Amber or another NIP-46 signer.</p>
    {#if nc}
      <QrCode data={nc.uri} />
      <p class="mono">{nc.uri}</p>
      <p class="muted">Waiting for the signer to approve…</p>
    {:else}
      <button class="btn" onclick={startNostrConnect} disabled={busy}>
        Connect a remote signer
      </button>
    {/if}
  </div>

  <div class="card">
    <h2>Have a key already?</h2>
    <p class="muted">Paste an nsec, an encrypted key (ncryptsec), or a bunker:// URI.</p>
    <input
      placeholder="nsec1… / ncryptsec1… / bunker://…"
      bind:value={pasteKey}
      autocomplete="off"
      spellcheck="false"
    />
    {#if pasteKey.trim().startsWith("ncryptsec1")}
      <input type="password" placeholder="Passphrase" bind:value={pastePw} />
    {/if}
    <div class="row" style="margin-top:0.5rem">
      {#if looksLikeBunker}
        <button class="btn" onclick={pasteBunker} disabled={busy}>Connect bunker</button>
      {:else}
        <button class="btn" onclick={importLocal} disabled={busy || !pasteKey.trim()}>
          Import key
        </button>
      {/if}
    </div>
  </div>
{/if}
