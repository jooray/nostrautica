<script lang="ts">
  // Existing-Nostr-user sign-in methods (spec §5.1): NIP-07 extension, NIP-46
  // remote signer (Amber), and pasted key / bunker. Shared by the Login and Join
  // pages. Calls `onSignedIn` once a session is established.
  import { session } from "$lib/signer/session.svelte.js";
  import { hasNip07 } from "$lib/signer/nip07.js";
  import {
    Nip46Signer,
    onNip46AuthUrl,
    type NostrConnectHandle,
  } from "$lib/signer/nip46.js";
  import { NIP46_RELAYS } from "$lib/nostr/relays.js";
  import QrCode from "$lib/components/QrCode.svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import { onMount } from "svelte";

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
  // Mobile field failure: opening the signer app backgrounds this tab and its
  // sockets, and the signer's approval reply (ephemeral kind 24133) can be lost
  // in that gap. If we return to the foreground still waiting, offer a retry
  // (fresh URI) after a short grace period.
  let ncHint = $state(false);
  // A remote signer's auth_url challenge opens via window.open (fast path),
  // but mobile browsers block that outside a user gesture. The blocked URL
  // lands here and is rendered as a tappable link instead.
  let authUrl = $state<string | null>(null);

  $effect(() => onNip46AuthUrl((url) => (authUrl = url)));

  $effect(() => {
    if (!nc) {
      ncHint = false;
      return;
    }
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      setTimeout(() => {
        if (nc) ncHint = true;
      }, 3000);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  });

  async function retryNostrConnect() {
    nc?.cancel();
    // Let the cancelled attempt unwind (its run() resets busy/nc) first.
    await new Promise((r) => setTimeout(r, 50));
    startNostrConnect();
  }

  async function copyUri() {
    if (!nc) return;
    await navigator.clipboard.writeText(nc.uri);
    copiedUri = true;
    setTimeout(() => (copiedUri = false), 1500);
  }

  const looksLikeBunker = $derived(pasteKey.trim().startsWith("bunker://"));

  async function run(fn: () => Promise<void>) {
    error = null;
    authUrl = null;
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
      // The auth link only makes sense while its attempt is still pending.
      authUrl = null;
    }
  }

  const loginNip07 = () =>
    run(async () => {
      await session.loginNip07();
      remember("nip07");
    });

  // NOT routed through run(): the QR is shown passively on mount and waits for a
  // scan that may never come, so it must NOT hold the global `busy` flag — doing
  // so would keep the extension + paste buttons disabled the whole time (a user
  // with Alby couldn't sign in). It manages its own error/success instead.
  async function startNostrConnect() {
    error = null;
    const handle = Nip46Signer.startNostrConnect(NIP46_RELAYS);
    nc = handle;
    try {
      const signer = await handle.connected;
      await session.loginNip46(signer);
      remember("nip46");
      onSignedIn?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A user-initiated Cancel isn't an error — reset quietly.
      if (msg !== "Cancelled") error = msg;
    } finally {
      nc = null;
    }
  }

  function cancelNostrConnect() {
    nc?.cancel();
  }

  // Show the remote-signer QR immediately — no extra "Connect" click. Start
  // nostrconnect on mount (it subscribes to all NIP46_RELAYS in parallel) and
  // tear it down if the user leaves without connecting.
  onMount(() => {
    if (!nc) startNostrConnect();
    return () => nc?.cancel();
  });

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

  {#if authUrl}
    <!-- Popup-blocked auth_url: give the user a real tap to open it. -->
    <div class="card warn" style="margin:0">
      <p style="margin:0">{t("signin.remote.authRequired")}</p>
      <a
        class="btn primary"
        href={authUrl}
        target="_blank"
        rel="noopener noreferrer"
        style="margin-top:0.5rem"
      >
        {t("signin.remote.openAuth")}
      </a>
    </div>
  {/if}

  {#if hasNip07()}
    <div style="order:{order('nip07', 1)}">
      <div class="field-label">{t("signin.extension")}</div>
      <button class="btn" onclick={loginNip07} disabled={busy}>
        {t("signin.extension.button")}
      </button>
    </div>
  {/if}

  <div style="order:{order('nip46', 2)}">
    <div class="field-label">{t("signin.remote")}</div>
    {#if nc}
      <p class="muted">{t("signin.remote.scan")}</p>
      <QrCode data={nc.uri} />
      <!-- Tapping opens Amber (nostrconnect:// deep link) on the same device. -->
      <a class="btn primary" href={nc.uri} style="margin-top:0.5rem">{t("signin.remote.openAmber")}</a>
      <div class="row" style="margin-top:0.5rem">
        <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{nc.uri}</span>
        <button class="btn inline" style="flex:none" aria-live="polite" onclick={copyUri}>
          {copiedUri ? t("signin.remote.copied") : t("signin.remote.copy")}
        </button>
      </div>
      <p class="muted" style="margin-top:0.5rem">{t("signin.remote.waiting")}</p>
      {#if ncHint}
        <p class="muted" style="margin-top:0.25rem">{t("signin.remote.staleHint")}</p>
        <button class="btn inline" style="margin-top:0.25rem" onclick={retryNostrConnect}>
          {t("signin.remote.retry")}
        </button>
      {/if}
      <button class="btn inline" style="margin-top:0.25rem" onclick={cancelNostrConnect}>
        {t("signin.remote.cancel")}
      </button>
    {:else}
      <p class="muted" style="margin:0 0 0.5rem">{t("signin.remote.hint")}</p>
      <button class="btn" onclick={startNostrConnect} disabled={busy}>
        {t("signin.remote.connect")}
      </button>
    {/if}
  </div>

  <div style="order:{order('paste', 3)}">
    <div class="field-label">{t("signin.paste")}</div>
    <input
      placeholder={t("signin.paste.placeholder")}
      bind:value={pasteKey}
      autocomplete="off"
      spellcheck="false"
    />
    {#if pasteKey.trim().startsWith("ncryptsec1")}
      <input type="password" placeholder={t("signin.paste.passphrase")} bind:value={pastePw} />
    {/if}
    <div class="row" style="margin-top:0.5rem">
      {#if looksLikeBunker}
        <button class="btn" onclick={pasteBunker} disabled={busy}>{t("signin.paste.connectBunker")}</button>
      {:else}
        <button class="btn" onclick={importLocal} disabled={busy || !pasteKey.trim()}>
          {t("signin.paste.import")}
        </button>
      {/if}
    </div>
    {#if bunkerConnecting}
      <p class="muted" style="margin:0.5rem 0 0">{t("signin.paste.contacting")}</p>
      <button class="btn inline" style="margin-top:0.25rem" onclick={cancelBunker}>
        {t("signin.paste.cancel")}
      </button>
    {/if}
    <p class="muted" style="margin:0.5rem 0 0">
      {t("signin.paste.saferHint")}
    </p>
  </div>
</div>
