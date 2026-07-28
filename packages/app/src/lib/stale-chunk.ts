/**
 * One-shot recovery from a post-deploy stale module graph (PWA §10.2).
 *
 * After a deploy the old shell still references content-hashed chunks that no
 * longer exist (404). Dynamic import then fails with "Failed to fetch
 * dynamically imported module". A plain reload loads the new index.html and
 * fixes it — but we must never loop if the reload itself is still broken.
 *
 * Latch is a timestamp in sessionStorage: refuse another reload within
 * COOLDOWN_MS of the last one. A healthy tab past the cooldown can recover
 * again on a later deploy.
 *
 * R8: the recovery reload is routed through `refreshGuard` — the SAME guard that
 * protects a completed recording / selected file / unsaved draft from the
 * automatic service-worker reload. A stale-chunk reload is just as destructive
 * to in-memory media, so it must DEFER while unsaved work is held and apply only
 * once it clears. The cooldown latch is set when the guarded reload actually
 * RUNS (not when it's merely requested), so a reload deferred behind unsaved work
 * doesn't burn the cooldown window before it ever happens.
 *
 * R9 (prod incident 2026-07-28, Firefox): a plain reload CANNOT fix this when a
 * service worker is serving a frozen precached shell. Navigations are answered
 * by the SW's NavigationRoute from the precached `index.html`, so reloading just
 * re-boots the identical dead module graph — the reload burns the cooldown, the
 * dead-end card appears, and only a hard reload (which bypasses the SW for that
 * one navigation) appears to work, until the next normal navigation breaks
 * again. So recovery ESCALATES: reload once, and if a stale chunk is still
 * failing after that, purge Cache Storage + unregister the worker before
 * reloading, which is the only exit from a precache that will never refresh.
 */
import { isStaleChunkError } from "$lib/nostr/errors.js";
import { refreshGuard } from "$lib/stores/refresh-guard.svelte.js";

const LATCH_KEY = "nostrautica:stale-chunk-reload";
/** Set once we've nuked the SW this session, so we never do it twice (R9). */
const PURGE_KEY = "nostrautica:stale-chunk-purged";
/** Refuse a second auto-reload inside this window (guards broken deploys). */
const COOLDOWN_MS = 15_000;

function lastReloadAt(): number {
  try {
    const raw = sessionStorage.getItem(LATCH_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function markReloaded(): void {
  try {
    sessionStorage.setItem(LATCH_KEY, String(Date.now()));
  } catch {
    /* private mode — still reload; worst case a second failure shows the UI */
  }
}

function alreadyPurged(): boolean {
  try {
    return !!sessionStorage.getItem(PURGE_KEY);
  } catch {
    return false;
  }
}

function markPurged(): void {
  try {
    sessionStorage.setItem(PURGE_KEY, "1");
  } catch {
    /* private mode — the purge still runs, it just isn't remembered */
  }
}

/**
 * Drop every Cache Storage entry and unregister every service worker, then
 * reload (R9). This is the escape hatch from a precached shell that will never
 * refresh itself: with the worker gone the reload goes to the network, gets the
 * current `index.html` with live chunk URLs, and `registerPwa()` re-registers a
 * fresh worker on the next boot — so offline support returns immediately rather
 * than being permanently sacrificed.
 *
 * Only ever called when ONLINE (see `recoverFromStaleChunk`): purging caches
 * offline would trade a broken route for a completely dead app. Every step is
 * best-effort — the reload happens even if the purge partly fails, because a
 * reload with a stale worker is still no worse than the state we're in.
 */
export async function purgeServiceWorkerAndReload(): Promise<void> {
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
    }
  } catch {
    /* Cache Storage unavailable (private mode) — fall through to unregister */
  }
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    if (regs) await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
  } catch {
    /* no SW support / blocked — fall through to the reload */
  }
  window.location.reload();
}

/**
 * If `reason` looks like a missing post-deploy chunk (or is omitted — used by
 * the vite:preloadError path which already means that), request a guarded reload
 * once per cooldown window. Returns true when recovery was requested so callers
 * can skip rendering a dead-end error surface.
 *
 * The reload goes through `refreshGuard`: it fires immediately when no unsaved
 * work is held, or defers until the last dirty holder (a completed recording, a
 * selected file, an unsaved form) clears — then the cooldown latch is stamped as
 * it runs. Deferral means a completed take is never destroyed by a stale-chunk
 * reload the way `window.location.reload()` used to (R8).
 */
export function recoverFromStaleChunk(reason?: unknown, opts?: { force?: boolean }): boolean {
  if (typeof window === "undefined") return false;
  if (reason !== undefined && !isStaleChunkError(reason)) return false;
  const last = lastReloadAt();
  // `force` (the Retry button) skips the cooldown: the user is explicitly asking
  // again, and by then a plain reload has demonstrably not helped.
  if (!opts?.force && last && Date.now() - last < COOLDOWN_MS) return false;
  // Escalate (R9) when a reload already happened this session and the chunk is
  // STILL missing — that combination means the shell we keep re-booting is
  // being served by a worker whose precache no longer matches the server.
  // Requires being online: a purge offline would leave nothing to boot from.
  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  const escalate = online && !alreadyPurged() && (!!opts?.force || last !== 0);
  refreshGuard.requestRefresh(() => {
    // Latch only when the reload ACTUALLY runs (possibly after unsaved work
    // clears), so a deferred reload doesn't spend the cooldown before it happens.
    markReloaded();
    if (escalate) {
      markPurged();
      void purgeServiceWorkerAndReload();
    } else {
      window.location.reload();
    }
  });
  return true;
}

/**
 * Catch stale-chunk failures that escape page-level try/catch (and Vite's
 * preload path). Safe to call once at boot alongside installRelayErrorGuard.
 */
export function installStaleChunkRecovery(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("vite:preloadError", (event) => {
    const err = (event as Event & { payload?: unknown }).payload;
    if (recoverFromStaleChunk(err ?? "Failed to fetch dynamically imported module")) {
      event.preventDefault();
    }
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (recoverFromStaleChunk(event.reason)) event.preventDefault();
  });
}

/** @deprecated kept for tests that pin the old name; no-op with timestamp latch. */
export function clearStaleChunkReloadLatch(): void {
  try {
    sessionStorage.removeItem(LATCH_KEY);
  } catch {
    /* ignore */
  }
}
