/**
 * Service-worker registration + auto-update (spec §10.2). autoUpdate is set on
 * the plugin (skipWaiting + clientsClaim); here we add the periodic update check
 * and the visibilitychange check so the app is never stuck on an old version
 * mid-event.
 */

// `virtual:pwa-register` is provided by vite-plugin-pwa at build time.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - virtual module resolved by the PWA plugin
import { registerSW } from "virtual:pwa-register";

const UPDATE_INTERVAL_MS = 60_000; // 60s while the app is open (spec §10.2)

export function registerPwa(): void {
  if (typeof window === "undefined") return;

  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(swUrl: string, registration: ServiceWorkerRegistration | undefined) {
      if (!registration) return;

      const check = async () => {
        // Bypass the HTTP cache for the SW update check (spec §10.2).
        try {
          await fetch(swUrl, { cache: "no-store" });
          await registration.update();
        } catch {
          /* offline — try again next tick */
        }
      };

      setInterval(check, UPDATE_INTERVAL_MS);
      // iOS applies updates on relaunch; re-check when the tab becomes visible.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void check();
      });
    },
    onNeedRefresh() {
      // autoUpdate takes over; nothing required. A toast could be shown here.
    },
  });

  // Expose for manual "update now" affordances if needed later.
  (window as any).__nostrauticaUpdateSW = updateSW;
}
