<script lang="ts">
  import "$lib/styles/app.css";
  import { onMount } from "svelte";
  import { tick } from "svelte";
  import { router } from "$lib/router/router.svelte.js";
  import { eventNaddr, routeTitleKey } from "$lib/router/routes.js";
  import type { MessageKey } from "$lib/i18n/messages.js";
  import { syncEventTheme } from "$lib/events/theme-injector.js";
  import { theme } from "$lib/stores/theme.svelte.js";
  import { i18n, t } from "$lib/i18n/i18n.svelte.js";
  import { session, consumeNsecFromHash } from "$lib/signer/session.svelte.js";
  import { online } from "$lib/stores/online.svelte.js";
  import { installQueueFlusher, flushQueue } from "$lib/nostr/publish-queue.js";
  import { installRelayErrorGuard } from "$lib/nostr/errors.js";
  import { registerPwa } from "$lib/pwa.js";
  import { hydrateAppCache } from "$lib/cache/persist.js";
  import { prefetchIdentity } from "$lib/nostr/prefetch.js";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { eventShell } from "$lib/stores/event-shell.svelte.js";
  import TopBar from "$lib/components/TopBar.svelte";
  import BottomNav from "$lib/components/BottomNav.svelte";
  import EventNav from "$lib/components/EventNav.svelte";
  import EventHeader from "$lib/components/EventHeader.svelte";

  let { children } = $props();
  let booted = $state(false);
  let main = $state<HTMLElement | null>(null);
  let routeAnnounce = $state("");
  // Skip focusing/announcing the very first render so we don't steal focus from a
  // deep-linked page's own load; subsequent navigations manage focus + announce.
  let firstRoute = true;

  onMount(async () => {
    installRelayErrorGuard();
    theme.init();
    i18n.init();
    online.init();
    recentEvents.init();
    router.init();
    // Warm the persistent app-cache mirror BEFORE booting so every page's
    // cachedX() helper paints on first render (CACHING-PLAN §1.1). Bounded to
    // 1500 ms internally, so a slow/broken IDB never blocks boot.
    await hydrateAppCache();
    // Consume any nsec carried in #/login?nsec= and strip it from history first.
    await consumeNsecFromHash();
    if (!session.loggedIn) await session.restore().catch(() => {});
    installQueueFlusher();
    void flushQueue();
    registerPwa();
    booted = true;
    // Identity-scoped warmers (§2.15): grants, recovery, own kind-0, follows,
    // mutes, DM relay list, blind seed (local only), one DM inbox scan. Silent
    // (fire-and-forget) and silent-signer-guarded inside the warmer.
    if (session.signer) prefetchIdentity(session.signer);
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
    void syncEventTheme(eventNaddr(router.route));
  });

  // Shared event context/role for the shell nav + persistent header (§4.4).
  // Reads session.pubkey so it re-syncs the role on login/logout.
  $effect(() => {
    if (!booted) return;
    void session.pubkey;
    void eventShell.sync(eventNaddr(router.route));
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
  {#if !online.isOnline}
    <div class="card warn" style="margin:0.5rem 0" role="status" aria-live="polite">
      {t("app.offline")}
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
