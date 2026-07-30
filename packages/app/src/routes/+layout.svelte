<script lang="ts">
  import "$lib/styles/app.css";
  import { onMount, untrack } from "svelte";
  import { tick } from "svelte";
  import { router } from "$lib/router/router.svelte.js";
  import { eventNaddr, routeTitleKey } from "$lib/router/routes.js";
  import type { MessageKey } from "$lib/i18n/messages.js";
  import { syncEventTheme } from "$lib/events/theme-injector.js";
  import { secretSurface } from "$lib/stores/secret-surface.svelte.js";
  import { theme } from "$lib/stores/theme.svelte.js";
  import { i18n, t } from "$lib/i18n/i18n.svelte.js";
  import { session, consumeNsecFromHash } from "$lib/signer/session.svelte.js";
  import { initSessionBroadcast } from "$lib/signer/session-broadcast.js";
  import { onNip46AuthUrl } from "$lib/signer/nip46.js";
  import { loadLoginMethod } from "$lib/signer/keystore.js";
  import { online } from "$lib/stores/online.svelte.js";
  import { connectivity } from "$lib/stores/connectivity.svelte.js";
  import { updatePrompt } from "$lib/stores/update-prompt.svelte.js";
  import { refreshGuard } from "$lib/stores/refresh-guard.svelte.js";
  import { installQueueFlusher, flushQueue } from "$lib/nostr/publish-queue.js";
  import { installRelayErrorGuard } from "$lib/nostr/errors.js";
  import { installStaleChunkRecovery } from "$lib/stale-chunk.js";
  import { registerPwa } from "$lib/pwa.js";
  import { install } from "$lib/stores/install.svelte.js";
  import { hydrateAppCache } from "$lib/cache/persist.js";
  import { prefetchIdentity } from "$lib/nostr/prefetch.js";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { eventShell } from "$lib/stores/event-shell.svelte.js";
  import { chatSession } from "$lib/chat/session.svelte.js";
  import { shouldPrewarmChat } from "$lib/chat/gate.js";
  import TopBar from "$lib/components/TopBar.svelte";
  import OperationStatus from "$lib/components/OperationStatus.svelte";
  import { opStatus } from "$lib/stores/op-status.svelte.js";
  import BottomNav from "$lib/components/BottomNav.svelte";
  import EventNav from "$lib/components/EventNav.svelte";
  import EventHeader from "$lib/components/EventHeader.svelte";
  import { releaseSummary } from "$lib/release.js";
  import { dmUnread } from "$lib/stores/dm-unread.svelte.js";
  import { cachedDms, fetchDms } from "$lib/events/dm.js";
  import { cacheHydration } from "$lib/cache/hydration.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";

  let { children } = $props();
  let booted = $state(false);
  let main = $state<HTMLElement | null>(null);
  let routeAnnounce = $state("");
  let signerAuthUrl = $state<string | null>(null);
  // Skip focusing/announcing the very first render so we don't steal focus from a
  // deep-linked page's own load; subsequent navigations manage focus + announce.
  let firstRoute = true;
  let prefetchedIdentity: string | null = null;

  /**
   * Dismiss the cold-boot splash (item 3). onMount fires after this component's
   * DOM is inserted, i.e. the real app has painted behind the splash — so fading
   * it out here reveals a ready shell, never a blank frame. Fade, then remove.
   */
  function dismissSplash(): void {
    if (typeof document === "undefined") return;
    const splash = document.getElementById("app-splash");
    if (!splash) return;
    splash.classList.add("splash-hide");
    setTimeout(() => splash.remove(), 320);
  }

  onMount(async () => {
    dismissSplash();
    // Release provenance (§13.9): log the embedded manifest once so a deployed
    // bundle can be identified from the console without server access.
    console.info(releaseSummary());
    installRelayErrorGuard();
    // Post-deploy missing-chunk recovery (PWA §10.2): one-shot reload on
    // vite:preloadError / unhandled dynamic-import TypeError so users never
    // need a manual hard refresh after a push.
    installStaleChunkRecovery();
    // H-5: drop this identity's owner state here if another tab logs it out.
    initSessionBroadcast((owner) => session.applyRemoteLogout(owner));
    theme.init();
    i18n.init();
    online.init();
    connectivity.init();
    recentEvents.init();
    router.init();
    // UX-21: capture beforeinstallprompt synchronously — it fires once, early,
    // and never waits for the async boot below (registerPwa inits it too,
    // idempotently, as a backstop). SW-independent.
    install.init();
    // Warm the persistent app-cache mirror in the BACKGROUND (§7.4.5). Boot no
    // longer awaits this — the shell + route render immediately, and cache-backed
    // pages re-read the mirror when `cacheHydration` fires (they watch it), so a
    // slow/broken IndexedDB never delays first paint by up to 1.5 s. Fire-and-
    // forget; `hydrateAppCache` is internally idempotent + bounded.
    void hydrateAppCache();
    // Consume any nsec carried in #/login?nsec= and strip it from history first.
    await consumeNsecFromHash();
    // UX-19: never gate the shell on a NIP-46 reconnect — a dead signer relay
    // otherwise burns connect (12s) + getPublicKey (12s) before `booted`,
    // delaying queue-flush/prefetch/registration behind it. Local/nip07
    // restores are local-only and fast, so those stay awaited (first paint
    // remains logged-in); nip46 restores in the background and pages react to
    // session.loggedIn flipping (Home/Me already render it reactively).
    const method = session.loggedIn
      ? undefined
      : await loadLoginMethod().catch(() => undefined);
    let restored: Promise<boolean>;
    if (session.loggedIn) {
      restored = Promise.resolve(true);
    } else if (method === "nip46") {
      // Background — the 2×12s worst case must not block the shell.
      restored = session.restore().catch(() => false);
    } else {
      // Local/nip07 (or no) restore: local-only and fast — keep it awaited.
      restored = session.restore().catch(() => false);
      await restored;
    }
    installQueueFlusher();
    void flushQueue();
    registerPwa();
    booted = true;
    // Identity-scoped warmers (§2.15): grants, recovery, own kind-0, follows,
    // mutes, DM relay list, blind seed (local only), one DM inbox scan. Silent
    // (fire-and-forget) and silent-signer-guarded inside the warmer. Fires once
    // the (possibly background) restore has settled.
    void restored;
  });

  // auth_url can arrive during any signer RPC, long after the login component
  // has unmounted. Keep a shell-level, user-gesture-safe approval link available.
  $effect(() => onNip46AuthUrl((url) => (signerAuthUrl = url)));

  // Run identity warmers after both restoration and an explicit later login.
  $effect(() => {
    const pubkey = session.pubkey;
    const signer = session.signer;
    if (!booted || !pubkey || !signer || prefetchedIdentity === pubkey) return;
    prefetchedIdentity = pubkey;
    untrack(() => prefetchIdentity(signer));
  });

  // Lazy ciphertext-only inbox activity poll. This exists only while the app is
  // alive (there is no service-worker/background polling) and never asks a signer
  // to decrypt, so Amber/NIP-46 cannot be prompted just to paint a nav badge.
  $effect(() => {
    void cacheHydration.version;
    const owner = session.pubkey;
    if (!booted || !owner) {
      untrack(() => dmUnread.init(null));
      return;
    }
    untrack(() => {
      dmUnread.init(owner);
      dmUnread.syncMessages(owner, cachedDms(owner));
    });
    let stopped = false;
    const poll = async () => {
      await connectNdk().catch(() => {});
      if (stopped) return;
      // Local keys can unwrap silently, so keep an accurate unread count warm.
      // Remote/extension signers stay ciphertext-only to avoid surprise prompts.
      if (session.signer?.method === "local" || session.signer?.getSecretKey?.()) {
        const messages = await fetchDms(session.signer).catch(() => undefined);
        if (!stopped && messages) {
          dmUnread.syncMessages(owner, messages);
          dmUnread.acknowledgeEncryptedActivity();
        }
      } else {
        await dmUnread.pollEncryptedInbox(owner).catch(() => {});
      }
    };
    void untrack(poll);
    const timer = setInterval(() => void untrack(poll), 30_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  });

  // A finished operation's confirmation belongs to the screen it happened on
  // (user report 2026-07-30). The status line lives in this layout, above every
  // screen, and its documented "until the user's next edit" lifetime silently
  // assumed the user stays on the form — so a publish confirmation followed them
  // across the whole app until reload. Navigation ends it.
  //
  // Tracks ONLY the route: `clearOnNavigate` reads no state, so this effect never
  // becomes a subscriber of the status it clears (which would wipe each new
  // message the instant it was set).
  $effect(() => {
    void router.route;
    opStatus.clearOnNavigate();
  });

  // Per-route document title, focus management, and a polite announcement (A2).
  // On every navigation set the localized title, move focus to <main> (which
  // holds the page's h1) without scrolling, and announce the title once — so a
  // screen reader gets a single useful route-change signal and focus never
  // strands on a removed control.
  $effect(() => {
    if (!booted) return;
    const key = routeTitleKey(router.route) as MessageKey;
    void i18n.locale; // re-run on locale change so the title stays localized
    const pageTitle = t(key);
    if (typeof document !== "undefined") {
      document.title = key === "title.home" ? "Nostrautica" : `${pageTitle} · Nostrautica`;
    }
    if (firstRoute) {
      firstRoute = false;
      return;
    }
    void (async () => {
      await tick();
      main?.focus({ preventScroll: true });
      routeAnnounce = pageTitle;
    })();
  });

  // Event theme lifecycle (spec §7.4): the single <style data-event-theme>
  // exists only while an #/e/<naddr> route is active — never on login,
  // settings, key-backup or DM routes — and swaps when the event changes.
  $effect(() => {
    if (!booted) return;
    // Re-run when a secret surface opens/closes (§13.3): while one is active the
    // injector suppresses theming (already removed synchronously on enter); when
    // the last closes, this re-syncs the current route's theme back in.
    void secretSurface.active;
    void syncEventTheme(eventNaddr(router.route));
  });

  // Shared event context/role for the shell nav + persistent header (§4.4).
  // Reads session.pubkey so it re-syncs the role on login/logout. Uses the
  // shell naddr (Bug 1): on the global chat routes that resolves to the active
  // event context, so the event nav's tab gating (showChat/showPeople/role) is
  // available there without re-fetching heavy state.
  $effect(() => {
    if (!booted) return;
    void session.pubkey;
    void session.custodyGeneration;
    if (session.pubkey && !session.custodyReady) return;
    void eventShell.sync(shellNaddr);
  });

  // Active event context (Bug 1): remember the event the user is currently inside
  // so a hop into the global chat list / a DM keeps the full event nav and the
  // DM → chat list → event → All events back-stack. Set on any event route; the
  // moment the user reaches the global events list (home) the context clears.
  // Chat/DM and other global routes (me/settings) leave it untouched — "you're in
  // this event" persists as long as possible.
  $effect(() => {
    if (!booted) return;
    const r = router.route;
    const evn = eventNaddr(r);
    if (evn) router.setEventOrigin(evn);
    else if (r.name === "home") router.setEventOrigin(undefined);
  });

  // Marmot chat prewarm (MARMOT-GROUP-CHAT §4.2). The coordinator can only add a
  // member once that member has advertised a key package, and MLS hands a new
  // member nothing from before their Add — so enrolling lazily on the first Chat
  // open means the first thing an attendee ever sees there is an empty room, with
  // any announcement made since their approval permanently unreadable. Start the
  // session as soon as the shell resolves an approved member of a chat-enabled
  // event, from whichever of its pages they're on, and keep it running in the
  // background: the Add, the welcome and the live 445 traffic all land while they
  // browse, so opening Chat paints an already-joined room. Deferred a beat so the
  // ~220 kB marmot chunk never competes with the page's own first load.
  $effect(() => {
    if (!booted) return;
    const naddr = eventNaddr(router.route);
    const ctx = eventShell.ctx;
    const signer = session.signer;
    const owner = session.pubkey;
    if (
      !shouldPrewarmChat({
        routeNaddr: naddr,
        shellNaddr: eventShell.naddr,
        hasCtx: !!ctx,
        hasSigner: !!signer,
        showChat: eventShell.showChat,
      }) ||
      !naddr ||
      !ctx ||
      !signer
    ) {
      // Leaving the event (or the account changed) — drop the live session; the
      // group state and message history stay in IndexedDB.
      untrack(() => chatSession.releaseUnless(naddr, owner));
      return;
    }
    const id = setTimeout(() => {
      void untrack(() => chatSession.ensure(naddr, ctx, signer, owner).catch(() => {}));
    }, 1500);
    return () => clearTimeout(id);
  });

  const evNaddr = $derived(eventNaddr(router.route));
  const routeName = $derived(router.route.name);
  // Bug 1: on the global chat routes (chat list, DM thread) eventNaddr() is
  // undefined, so fall back to the active event context — the event the user
  // walked in from — so the event nav + back-stack persist there. A fresh tab
  // opened straight to a DM has no context, so it keeps the global nav.
  const inChatContext = $derived(routeName === "dm" || routeName === "dmPeer");
  const shellNaddr = $derived(evNaddr ?? (inChatContext ? router.eventOrigin : undefined));
  // The layout owns one compact event header on subpages. EventHome renders its
  // own full hero; Record is chrome-light (focused recording flow); the Report
  // renders its own print-friendly event hero (so the PDF carries the graphics).
  const showCompactHeader = $derived(
    evNaddr !== undefined &&
      routeName !== "event" &&
      routeName !== "record" &&
      routeName !== "report",
  );
  const compactStatus = $derived.by(() => {
    switch (eventShell.role) {
      case "organizer":
      case "attendee":
        return { labelKey: "event.status.approved" as const, tone: "ok" as const };
      case "pending":
        return { labelKey: "event.status.pending" as const, tone: "warn" as const };
      default:
        return { labelKey: "event.status.visitor" as const, tone: "neutral" as const };
    }
  });
</script>

<!-- The other half of the status line's documented lifetime: the user editing
     anything means the last operation's confirmation is stale. Wired once here
     rather than per-form because `opStatus.clearOnEdit()` was only ever called
     from Record.svelte — every other form in the app (event settings included)
     promised this lifetime in the store's contract and never delivered it.
     Input events bubble to the document, so this covers every field. Safe as a
     DOM handler: unlike an $effect, reading status state here subscribes to
     nothing. -->
<svelte:document oninput={() => opStatus.clearOnEdit()} />

<a class="skip-link" href="#main-content">{t("a11y.skipToContent")}</a>

<div class="app-shell">
  <TopBar />
  {#if updatePrompt.needed}
    <div class="card warn" style="margin:0.5rem 0" role="alert" aria-live="assertive">
      {t("update.available")}
      <button type="button" class="btn" style="margin-left:0.5rem" onclick={() => updatePrompt.update()}>
        {t("update.action")}
      </button>
    </div>
  {/if}
  <!-- Layered connectivity (§7.4.6): distinguish no-internet from the conference-
       WiFi case (online but WSS blocked) from a draining outbox — one banner,
       the right message. Only shown when something is actually wrong. -->
  {#if connectivity.overall === "offline"}
    <div class="card warn" style="margin:0.5rem 0" role="status" aria-live="polite">
      {t("app.offline")}
    </div>
  {:else if connectivity.overall === "relay-blocked"}
    <div class="card warn" style="margin:0.5rem 0" role="status" aria-live="polite">
      {t("conn.relayBlocked")}
    </div>
  {:else if connectivity.overall === "syncing"}
    <div class="card" style="margin:0.5rem 0" role="status" aria-live="polite">
      {t("conn.syncing")}
    </div>
  {/if}
  {#if refreshGuard.updateWaiting}
    <div class="card" style="margin:0.5rem 0" role="status" aria-live="polite">
      {t("update.deferred")}
    </div>
  {/if}
  {#if session.logoutError}
    <div class="card warn" style="margin:0.5rem 0" role="alert" aria-live="assertive">
      {t("logout.encryptFailed")}
      <button
        type="button"
        class="btn"
        style="margin-left:0.5rem"
        onclick={() => (session.logoutError = false)}
      >
        {t("logout.dismiss")}
      </button>
    </div>
  {/if}
  {#if signerAuthUrl}
    <div class="card warn" style="margin:0.5rem 0" role="alert" aria-live="assertive">
      {t("signin.remote.authRequired")}
      <a
        class="btn primary"
        href={signerAuthUrl}
        target="_blank"
        rel="noopener noreferrer"
        style="margin-left:0.5rem"
      >{t("signin.remote.openAuth")}</a>
      <button
        type="button"
        class="btn inline"
        style="margin-left:0.5rem"
        onclick={() => (signerAuthUrl = null)}
      >{t("logout.dismiss")}</button>
    </div>
  {/if}
  {#if showCompactHeader}
    {#if eventShell.ctx}
      <EventHeader ctx={eventShell.ctx} compact link status={compactStatus} />
    {:else}
      <div
        aria-hidden="true"
        style="height:3rem;margin:0.5rem 0 1rem;border-radius:var(--radius);background:var(--bg-elev2);opacity:0.5"
      ></div>
    {/if}
  {/if}
  <!-- Shared operation-status announcer (audit §7.3.9): Queued / Published /
       Coordinator-acknowledged, kept until the user navigates or edits again. -->
  <OperationStatus />
  <main id="main-content" bind:this={main} tabindex="-1">
    {#if booted}
      {@render children()}
    {:else}
      <p class="muted" style="margin-top:2rem">{t("app.loading")}</p>
    {/if}
  </main>
</div>

<!-- Polite route-change announcement for assistive tech (A2). -->
<div class="visually-hidden" role="status" aria-live="polite">{routeAnnounce}</div>

<!-- Bug 1: keep the full event nav on the global chat routes when there's an
     active event context AND the viewer is actually a member of it (U8/U5 role
     gating — a non-member's DMs still get the global nav, never a fabricated
     event shell). Real event routes always render it, as before. -->
{#if shellNaddr && (evNaddr || eventShell.isMember)}
  <EventNav naddr={shellNaddr} />
{:else}
  <BottomNav />
{/if}
