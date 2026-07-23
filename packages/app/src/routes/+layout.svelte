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
  import BottomNav from "$lib/components/BottomNav.svelte";
  import EventNav from "$lib/components/EventNav.svelte";
  import EventHeader from "$lib/components/EventHeader.svelte";
  import { releaseSummary } from "$lib/release.js";

  let { children } = $props();
  let booted = $state(false);
  let main = $state<HTMLElement | null>(null);
  let routeAnnounce = $state("");
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

  // Run identity warmers after both restoration and an explicit later login.
  $effect(() => {
    const pubkey = session.pubkey;
    const signer = session.signer;
    if (!booted || !pubkey || !signer || prefetchedIdentity === pubkey) return;
    prefetchedIdentity = pubkey;
    untrack(() => prefetchIdentity(signer));
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
  // Reads session.pubkey so it re-syncs the role on login/logout.
  $effect(() => {
    if (!booted) return;
    void session.pubkey;
    void eventShell.sync(eventNaddr(router.route));
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
  // The layout owns one compact event header on subpages. EventHome renders its
  // own full hero; Record is chrome-light (focused recording flow).
  const showCompactHeader = $derived(
    evNaddr !== undefined && routeName !== "event" && routeName !== "record",
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
  <!-- Shared, persistent operation-status announcer (audit §7.3.9): Queued /
       Published / Coordinator-acknowledged, kept until the user's next edit. -->
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

{#if evNaddr}
  <EventNav naddr={evNaddr} />
{:else}
  <BottomNav />
{/if}
