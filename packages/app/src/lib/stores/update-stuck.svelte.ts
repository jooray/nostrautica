/**
 * The user-facing half of the update watchdog (audit R-84).
 *
 * `pwa/update-health.ts` works out when this tab is stuck on an old build — the
 * served `sw.js` has not matched the running bundle for several checks, or the
 * service worker never registered — and used to say so only in the console,
 * where no user ever looks. The automatic paths (controllerchange, the plugin's
 * activation reload, stale-chunk recovery) are what normally move a tab
 * forward; this banner is for the case where they demonstrably have not, and
 * its button does the one thing that always gets the current build: purge the
 * caches, drop the worker, reload from the network.
 *
 * A confirmed drift first triggers that same action automatically, once per
 * served revision (`autoRecoverFromDrift`); the banner is what is left when
 * that attempt is spent and the tab is still stuck.
 *
 * Dismissable, but a dismissal lasts only for the current episode: a later,
 * separate failure shows the banner again.
 */
import { refreshGuard } from "$lib/stores/refresh-guard.svelte.js";
import { purgeServiceWorkerAndReload } from "$lib/stale-chunk.js";

export type UpdateStuckReason = "drift" | "register";

let reason = $state<UpdateStuckReason | null>(null);
let dismissed = $state(false);

export const updateStuck = {
  /** Why the banner is up, or null when it is not. */
  get reason(): UpdateStuckReason | null {
    return dismissed ? null : reason;
  },
  /** Raise (or keep) the banner for `next`; null clears it once the tab is healthy again. */
  set(next: UpdateStuckReason | null): void {
    if (next === reason) return;
    reason = next;
    dismissed = false;
  },
  dismiss(): void {
    dismissed = true;
  },
};

/**
 * Move this tab to the newest deployed build, now (the banner's button, and the
 * protocol "please update" prompt). Goes through `refreshGuard` like every
 * other reload, so unsaved work is still waited for.
 *
 * Not `updateSW(true)`: in autoUpdate mode the plugin's updater is a no-op
 * beyond awaiting registration (vite-plugin-pwa 1.3.0), so a button bound to
 * it did nothing. Offline, a plain reload: purging the caches with no network
 * would leave nothing to boot from.
 */
/** sessionStorage: the served sw.js revision the automatic recovery last ran for. */
const AUTO_RELOAD_KEY = "nostrautica:update-auto-reload";

/**
 * A stuck build was CONFIRMED (sustained sw.js drift): move this tab on its own,
 * without waiting for anyone to press the banner's button — the PWA must never
 * depend on the user to get a new version. Through `refreshGuard` like every
 * reload, so unsaved work is still waited for.
 *
 * At most once per served revision, latched in sessionStorage (which survives
 * the reload): if a stale proxy keeps answering with the same old sw.js, the
 * second confirmation of that revision does nothing and the banner is the
 * fallback, instead of a reload loop. A storage error means we cannot latch, so
 * it fails to "don't auto-reload" for the same reason. A NEW served revision
 * (another deploy) earns one more attempt. Returns whether it reloaded.
 */
export function autoRecoverFromDrift(revision: string): boolean {
  try {
    if (sessionStorage.getItem(AUTO_RELOAD_KEY) === revision) return false;
    sessionStorage.setItem(AUTO_RELOAD_KEY, revision);
  } catch {
    return false;
  }
  console.warn(`[pwa] stuck on an old build (served sw.js revision ${revision}); reloading to the latest build`);
  reloadToLatestBuild();
  return true;
}

export function reloadToLatestBuild(): void {
  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  refreshGuard.requestRefresh(() => {
    if (online) void purgeServiceWorkerAndReload();
    else window.location.reload();
  });
}
