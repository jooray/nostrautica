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
 */
import { isStaleChunkError } from "$lib/nostr/errors.js";

const LATCH_KEY = "nostrautica:stale-chunk-reload";
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

/**
 * If `reason` looks like a missing post-deploy chunk (or is omitted — used by
 * the vite:preloadError path which already means that), reload once per
 * cooldown window. Returns true when a reload was triggered so callers can
 * skip rendering a dead-end error surface.
 */
export function recoverFromStaleChunk(reason?: unknown): boolean {
  if (typeof window === "undefined") return false;
  if (reason !== undefined && !isStaleChunkError(reason)) return false;
  const last = lastReloadAt();
  if (last && Date.now() - last < COOLDOWN_MS) return false;
  markReloaded();
  window.location.reload();
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
