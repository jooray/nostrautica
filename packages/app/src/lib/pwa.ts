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
 *  - When the new worker takes control (`controllerchange`), we reload once — but
 *    only if the page was already controlled (so the very first install, which
 *    also fires controllerchange, does NOT reload).
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - virtual module resolved by the PWA plugin
import { registerSW } from "virtual:pwa-register";
import { install } from "$lib/stores/install.svelte.js";

const UPDATE_INTERVAL_MS = 60_000; // 60s while the app is open (spec §10.2)

export function registerPwa(): void {
  if (typeof window === "undefined") return;
  // Capture beforeinstallprompt early — it fires once, before any event page
  // mounts (UI-SUGGESTIONS #24). Independent of service-worker support.
  install.init();
  if (!("serviceWorker" in navigator)) return;

  // Reload exactly once when a newly-activated worker takes control.
  let reloaded = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded || !hadController) return;
    reloaded = true;
    window.location.reload();
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
