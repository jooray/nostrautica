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
export function reloadToLatestBuild(): void {
  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  refreshGuard.requestRefresh(() => {
    if (online) void purgeServiceWorkerAndReload();
    else window.location.reload();
  });
}
