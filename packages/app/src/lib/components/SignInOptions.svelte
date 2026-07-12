<script lang="ts">
  // Existing-Nostr-user sign-in methods (spec §5.1): NIP-07 extension, NIP-46
  // remote signer (Amber), and pasted key / bunker. Shared by the Login and Join
  // pages. Calls `onSignedIn` once a session is established.
  import { session } from "$lib/signer/session.svelte.js";
  import { hasNip07 } from "$lib/signer/nip07.js";
  import { Nip46Signer, type NostrConnectHandle } from "$lib/signer/nip46.js";
  import { DEFAULT_RELAYS } from "$lib/nostr/relays.js";
  import QrCode from "$lib/components/QrCode.svelte";

  let { onSignedIn }: { onSignedIn?: () => void } = $props();

  let error = $state<string | null>(null);
  let busy = $state(false);
  let nc = $state<NostrConnectHandle | null>(null);
  let pasteKey = $state("");
  let pastePw = $state("");
  let copiedUri = $state(false);

  async function copyUri() {
    if (!nc) return;
    await navigator.clipboard.writeText(nc.uri);
    copiedUri = true;
    setTimeout(() => (copiedUri = false), 1500);
  }

  const looksLikeBunker = $derived(pasteKey.trim().startsWith("bunker://"));

  async function run(fn: () => Promise<void>) {
    error = null;
    busy = true;
    try {
      await fn();
      onSignedIn?.();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const loginNip07 = () => run(() => session.loginNip07());

  const startNostrConnect = () =>
    run(async () => {
      nc = Nip46Signer.startNostrConnect(DEFAULT_RELAYS);
      const signer = await nc.connected;
      await session.loginNip46(signer);
      nc = null;
    });

  const pasteBunker = () =>
    run(async () => {
      const signer = await Nip46Signer.fromBunkerUri(pasteKey.trim());
      await session.loginNip46(signer);
    });

  const importLocal = () =>
    run(() => session.importLocalKey(pasteKey.trim(), pastePw || undefined));
</script>

<div class="card stack">
  {#if error}<div class="card warn" style="margin:0">{error}</div>{/if}

  {#if hasNip07()}
    <div>
      <div class="field-label">Browser extension</div>
      <button class="btn" onclick={loginNip07} disabled={busy}>
        Log in with extension (Alby, nos2x…)
      </button>
    </div>
  {/if}

  <div>
    <div class="field-label">Remote signer</div>
    {#if nc}
      <p class="muted">Scan this with Amber, or open it directly on this device:</p>
      <QrCode data={nc.uri} />
      <!-- Tapping opens Amber (nostrconnect:// deep link) on the same device. -->
      <a class="btn primary" href={nc.uri} style="margin-top:0.5rem">Open in Amber</a>
      <div class="row" style="margin-top:0.5rem">
        <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{nc.uri}</span>
        <button class="btn inline" style="flex:none" onclick={copyUri}>
          {copiedUri ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <p class="muted" style="margin-top:0.5rem">Waiting for the signer to approve…</p>
    {:else}
      <p class="muted" style="margin:0 0 0.5rem">such as Amber on Android, or Clave</p>
      <button class="btn" onclick={startNostrConnect} disabled={busy}>
        Connect with Remote Signer
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
