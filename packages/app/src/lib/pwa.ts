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

const UPDATE_INTERVAL_MS = 60_000; // 60s while the app is open (spec §10.2)

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
  });

  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(swUrl: string, registration: ServiceWorkerRegistration | undefined) {
      if (!registration) return;

      const check = async () => {
        try {
          // Bypass the HTTP cache so a cached sw.js can't mask a new deploy.
          await fetch(swUrl, { cache: "no-store" });
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
