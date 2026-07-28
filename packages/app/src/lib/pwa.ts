/**
 * Service-worker registration + AUTOMATIC update (spec §10.2). Goal: never stuck
 * on an old version, and no "click to reload" prompt — when a new deploy is
 * detected the app reloads itself.
 *
 * How it works:
 *  - registerType 'autoUpdate' (plugin) sets skipWaiting + clientsClaim, so a new
 *    service worker activates immediately and takes control of open pages.
 *  - We poll for updates (every 60s, on focus, on reconnect), bypassing the HTTP
 *    cache so a cached sw.js never hides a new deploy.
 *  - When the new worker takes control (`controllerchange`) we reload — but the
 *    VERY FIRST controller acquisition (the initial install claiming a
 *    previously-uncontrolled page, which also fires controllerchange) must NOT
 *    reload. App-1: the old code captured `hadController` once, so a tab that
 *    first-installed the worker had it false forever and then IGNORED every
 *    later update. We instead latch after the first acquisition, so exactly the
 *    initial claim is skipped and every subsequent controllerchange refreshes.
 *  - App-2: the reload is routed through `refreshGuard` so it defers while
 *    unsaved work is in progress and applies automatically once it clears —
 *    never a manual hard refresh (global PWA mandate), never lost drafts.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - virtual module resolved by the PWA plugin
import { registerSW } from "virtual:pwa-register";
import { install } from "$lib/stores/install.svelte.js";
import { refreshGuard } from "$lib/stores/refresh-guard.svelte.js";
import { ControllerLatch } from "$lib/pwa-latch.js";
import { warmRouteModules, CRITICAL_PARTICIPANT_ROUTES } from "$lib/router/route-modules.js";
import { ensureEntryShellCached } from "$lib/pwa/offline-shell.js";
const UPDATE_INTERVAL_MS = 60_000; // 60s while the app is open (spec §10.2)

/**
 * Warm the critical participant route chunks once the service worker is in
 * control (audit U7). Lazy route chunks aren't precached — they're runtime-cached
 * only when a controlling SW fetches them — so a participant who installs and
 * goes offline without visiting Record/Talks would find those screens missing.
 * Importing them here, on idle, lands their chunks in the SW runtime cache. Only
 * runs when a controller exists (otherwise the fetch wouldn't be cached) and only
 * once per page. Best-effort: failures (offline) are swallowed by warmRouteModules.
 */
let warmedRoutes = false;
function warmCriticalRoutesWhenControlled(): void {
  if (warmedRoutes || typeof navigator === "undefined") return;
  if (!navigator.serviceWorker?.controller) return; // no controller → fetch wouldn't cache
  warmedRoutes = true;
  const run = () => {
    // R7: warm the SHELL's entry JS/CSS first — these ride the entry chunk (not a
    // lazy route) and are NOT precached, so without this a first-visit-then-cold-
    // offline-launch serves the precached index.html and 404s its own scripts.
    // Then warm the critical lazy participant routes.
    void ensureEntryShellCached();
    void warmRouteModules(CRITICAL_PARTICIPANT_ROUTES);
  };
  const ric = (window as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (typeof ric === "function") ric(run);
  else setTimeout(run, 3000);
}

export function registerPwa(): void {
  if (typeof window === "undefined") return;
  // Backstop for the layout's synchronous install.init() (UX-21): capture
  // beforeinstallprompt even if registerPwa is the first to run. Idempotent.
  install.init();
  if (!("serviceWorker" in navigator)) return;

  // Reload when a newly-activated worker takes control — skipping only the
  // initial install claim (App-1) and deferring while unsaved work is in
  // progress (App-2).
  const latch = new ControllerLatch(!!navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (latch.shouldReload()) {
      refreshGuard.requestRefresh(() => window.location.reload());
    }
    // A newly-acquired controller can now cache runtime fetches — warm the
    // critical participant chunks (U7). Skipped when the change triggers a reload.
    else warmCriticalRoutesWhenControlled();
  });
  // Already controlled on load (returning visitor) — warm now.
  warmCriticalRoutesWhenControlled();

  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(swUrl: string, registration: ServiceWorkerRegistration | undefined) {
      if (!registration) return;

      const check = async () => {
        try {
          // PRIME the HTTP cache with the current sw.js, then update.
          //
          // This used to be `cache: "no-store"`, which was the wrong tool: it
          // bypasses the cache for THIS request and stores nothing, so the
          // response was fetched and thrown away while `registration.update()`
          // below — a separate request — could still be answered from a stale
          // cache entry. `cache: "reload"` also bypasses the cache on the way
          // out but WRITES the fresh response back, so update() finds the new
          // script whether or not it consults the cache.
          //
          // Why this mattered (prod 2026-07-28): nginx served /app/sw.js via a
          // generic `\.(js|css|...)$ expires 1d` rule, so browsers could answer
          // their own update check from cache for up to 24h. Clients sat on an
          // old precached shell, and each 24h boundary let exactly one deploy
          // through before shutting again — which is why it looked intermittent
          // and browser-specific. The nginx side is fixed (sw.js is now
          // no-store), but the client must not depend on a server header to
          // notice a new version.
          await fetch(swUrl, { cache: "reload" });
          await registration.update();
        } catch {
          /* offline — try again next tick */
        }
      };

      setInterval(check, UPDATE_INTERVAL_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void check();
      });
      window.addEventListener("online", () => void check());
    },
    onNeedRefresh() {
      // A new version is waiting. With autoUpdate it will skipWaiting and the
      // controllerchange handler above reloads us — apply it immediately.
      void updateSW(true);
    },
  });

  // Expose for a manual "update now" affordance if ever needed.
  (window as any).__nostrauticaUpdateSW = updateSW;
}
