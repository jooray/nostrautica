<script lang="ts">
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { hasNip07 } from "$lib/signer/nip07.js";
  import { Nip46Signer, type NostrConnectHandle } from "$lib/signer/nip46.js";
  import { DEFAULT_RELAYS } from "$lib/nostr/relays.js";
  import { publishProfile, ensureRelayList } from "$lib/events/nostr-actions.js";
  import BackupCard from "$lib/components/BackupCard.svelte";
  import QrCode from "$lib/components/QrCode.svelte";
  import NostrichIcon from "$lib/components/NostrichIcon.svelte";

  let error = $state<string | null>(null);
  let busy = $state(false);
  let nc = $state<NostrConnectHandle | null>(null);
  let showExisting = $state(false);

  // New-user form
  let newName = $state("");
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

  const createNew = () =>
    run(async () => {
      await session.createLocalKey();
      // Publish a real kind-0 with their name so they're a proper Nostr user.
      if (newName.trim() && session.signer) {
        await publishProfile(session.signer, { name: newName.trim() }).catch(() => {});
        await ensureRelayList(session.signer).catch(() => {});
      }
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

{#if session.loggedIn && session.freshLocalKey}
  <h1>You're in 🎉</h1>
  <div class="card">
    <p class="muted">
      A Nostr identity was just created for you. Back it up now so you never lose
      access.
    </p>
    <BackupCard />
    <button class="btn primary" onclick={done} style="margin-top:0.75rem">Continue</button>
  </div>
{:else if session.loggedIn}
  <div class="card">
    <p>You're already logged in.</p>
    <button class="btn primary" onclick={done}>Continue</button>
  </div>
{:else}
  <h1>Welcome</h1>

  {#if error}
    <div class="card warn"><strong>Couldn't log in.</strong> {error}</div>
  {/if}

  <!-- Fast path for people who already have a Nostr account. -->
  <button
    class="btn primary"
    style="padding:0.9rem;font-size:1.05rem"
    onclick={() => (showExisting = !showExisting)}
  >
    <NostrichIcon size={24} />
    I'm already a Nostr user
  </button>

  {#if showExisting}
    <div class="card stack">
      {#if hasNip07()}
        <div>
          <div class="field-label">Browser extension</div>
          <button class="btn" onclick={loginNip07} disabled={busy}>
            Log in with extension (Alby, nos2x…)
          </button>
        </div>
      {/if}

      <div>
        <div class="field-label">Remote signer (Amber)</div>
        {#if nc}
          <QrCode data={nc.uri} />
          <p class="mono">{nc.uri}</p>
          <p class="muted">Waiting for the signer to approve…</p>
        {:else}
          <button class="btn" onclick={startNostrConnect} disabled={busy}>
            Scan a QR with Amber
          </button>
        {/if}
      </div>

      <div>
        <div class="field-label">Paste a key</div>
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
    </div>
  {/if}

  <div class="divider"><span>or</span></div>

  <!-- Everyone else just creates an identity right here. -->
  <div class="card">
    <h2>Create your identity</h2>
    <p class="muted">
      New to this? No problem — we'll set up a Nostr account for you. No password,
      no jargon.
    </p>
    <label for="nm">Your name</label>
    <input id="nm" bind:value={newName} placeholder="How should people know you?" />
    <button class="btn primary" style="margin-top:0.75rem" onclick={createNew} disabled={busy}>
      {busy ? "Creating…" : "Create my identity"}
    </button>
  </div>
{/if}

<style>
  .divider {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 1.25rem 0;
    color: var(--text-dim);
  }
  .divider::before,
  .divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border);
  }
</style>
