<script lang="ts">
  // Existing-Nostr-user sign-in methods (spec §5.1): NIP-07 extension, NIP-46
  // remote signer (Amber), and pasted key / bunker. Shared by the Login and Join
  // pages. Calls `onSignedIn` once a session is established.
  import { session } from "$lib/signer/session.svelte.js";
  import { hasNip07 } from "$lib/signer/nip07.js";
  import { Nip46Signer, type NostrConnectHandle } from "$lib/signer/nip46.js";
  import { NIP46_RELAYS } from "$lib/nostr/relays.js";
  import QrCode from "$lib/components/QrCode.svelte";

  let { onSignedIn }: { onSignedIn?: () => void } = $props();

  // Remember the last successful method and list it first next time
  // (UI-SUGGESTIONS #9). Flex `order` keeps the markup static.
  const LAST_KEY = "nostrautica:last-signin";
  const last =
    typeof localStorage !== "undefined" ? localStorage.getItem(LAST_KEY) : null;
  const order = (method: string, dflt: number) => (last === method ? 0 : dflt);
  function remember(method: string) {
    try {
      localStorage.setItem(LAST_KEY, method);
    } catch {
      /* private mode */
    }
  }

  let error = $state<string | null>(null);
  let busy = $state(false);
  let nc = $state<NostrConnectHandle | null>(null);
  let pasteKey = $state("");
  let pastePw = $state("");
  let copiedUri = $state(false);
  // In-flight bunker:// connect: a progress note + a working Cancel.
  let bunkerConnecting = $state(false);
  let bunkerAbort: AbortController | null = null;

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
      const msg = e instanceof Error ? e.message : String(e);
      // A user-initiated Cancel isn't an error — just reset the form quietly.
      error = msg === "Cancelled" ? null : msg;
    } finally {
      busy = false;
    }
  }

  const loginNip07 = () =>
    run(async () => {
      await session.loginNip07();
      remember("nip07");
    });

  const startNostrConnect = () =>
    run(async () => {
      const handle = Nip46Signer.startNostrConnect(NIP46_RELAYS);
      nc = handle;
      try {
        const signer = await handle.connected;
        await session.loginNip46(signer);
        remember("nip46");
      } finally {
        nc = null;
      }
    });

  function cancelNostrConnect() {
    nc?.cancel();
  }

  const pasteBunker = () =>
    run(async () => {
      bunkerAbort = new AbortController();
      bunkerConnecting = true;
      try {
        const signer = await Nip46Signer.fromBunkerUri(
          pasteKey.trim(),
          bunkerAbort.signal,
        );
        await session.loginNip46(signer);
        remember("paste");
      } finally {
        bunkerConnecting = false;
        bunkerAbort = null;
      }
    });

  function cancelBunker() {
    bunkerAbort?.abort();
  }

  const importLocal = () =>
    run(async () => {
      await session.importLocalKey(pasteKey.trim(), pastePw || undefined);
      remember("paste");
    });
</script>

<div class="card stack">
  {#if error}<div class="card warn" style="margin:0">{error}</div>{/if}

  {#if hasNip07()}
    <div style="order:{order('nip07', 1)}">
      <div class="field-label">Browser extension</div>
      <button class="btn" onclick={loginNip07} disabled={busy}>
        Log in with extension (Alby, nos2x…)
      </button>
    </div>
  {/if}

  <div style="order:{order('nip46', 2)}">
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
      <button class="btn inline" style="margin-top:0.25rem" onclick={cancelNostrConnect}>
        Cancel
      </button>
    {:else}
      <p class="muted" style="margin:0 0 0.5rem">such as Amber on Android, or Clave</p>
      <button class="btn" onclick={startNostrConnect} disabled={busy}>
        Connect with Remote Signer
      </button>
    {/if}
  </div>

  <div style="order:{order('paste', 3)}">
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
    {#if bunkerConnecting}
      <p class="muted" style="margin:0.5rem 0 0">Contacting your signer…</p>
      <button class="btn inline" style="margin-top:0.25rem" onclick={cancelBunker}>
        Cancel
      </button>
    {/if}
    <p class="muted" style="margin:0.5rem 0 0">
      On a shared device, a signer app or extension is safer than pasting your key.
    </p>
  </div>
</div>
