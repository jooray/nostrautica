/**
 * One stale-while-revalidate helper (CACHING-PLAN §1.2) built on persist.ts.
 *
 * Paint from the persistent cache synchronously, refresh from relays in the
 * background, apply the fresh value reactively. In-flight refreshes are deduped
 * per key (like prefetch.ts's `warm()`), and a short TTL keeps a remount from
 * re-hitting relays. Background refreshes never throw to the caller.
 */
import { cacheGet, cacheSet, activeCacheOwner, cacheGeneration } from "./persist.js";

export interface SwrOptions<T> {
  /** Cache scope: "anon" for public data, an owner pubkey, or omit for the
   *  active owner (persist.ts resolves it). */
  scope?: string;
  /** Skip the network refresh when the cached entry is younger than this. */
  ttlMs?: number;
  /**
   * `at` (newest source `created_at`) for the freshly fetched value, so
   * latest-wins in persist.ts holds. Given the fetched value; defaults to now.
   */
  atOf?: (fresh: T) => number;
}

// Dedupe concurrent/rapid refreshes per key, and remember when each last ran so
// a remount within `ttlMs` is a no-op (matches prefetch.ts semantics). These are
// keyed by the RESOLVED scope + key (audit App-5): cacheGet/cacheSet are
// scope-partitioned, so keying the dedupe/TTL maps by the bare key let a rapid
// identity switch (anon↔owner, or owner A↔B) reuse another scope's in-flight
// result or suppress a needed refresh. Resolve the scope exactly as persist.ts
// does (explicit wins, else the active owner).
const inflight = new Map<string, Promise<unknown>>();
const lastRefreshAt = new Map<string, number>();

const DEFAULT_TTL_MS = 15_000;

/** Scope-qualified dedupe key. \x1f can't occur in a pubkey or cache key. */
function dedupeKey(key: string, scope?: string): string {
  return `${scope ?? activeCacheOwner() ?? ""}\x1f${key}`;
}

/**
 * @param key      cache key (scoped by opts.scope)
 * @param fetcher  network fetch producing the fresh value
 * @param apply    called synchronously with the cached value (if any) for
 *                 instant paint, then again with the fresh value when it lands
 * @returns the fresh value (or cached, or undefined) for await-style callers
 */
export async function swr<T>(
  key: string,
  fetcher: () => Promise<T>,
  apply: (value: T, source: "cache" | "network") => void,
  opts: SwrOptions<T> = {},
): Promise<T | undefined> {
  const { scope, ttlMs = DEFAULT_TTL_MS, atOf } = opts;

  const cached = cacheGet<T>(key, scope);
  if (cached) apply(cached.data, "cache");

  // Dedupe/TTL bookkeeping is scope-qualified so a different owner (or anon)
  // never reuses this scope's in-flight result or TTL suppression.
  const dk = dedupeKey(key, scope);

  // Fresh enough / already refreshing: don't hit relays again.
  const last = lastRefreshAt.get(dk);
  if (last !== undefined && Date.now() - last < ttlMs) return cached?.data;
  const running = inflight.get(dk) as Promise<T | undefined> | undefined;
  if (running) return running.then((v) => v ?? cached?.data);

  // Capture the owner-cache generation before the async fetch so a logout that
  // lands while the fetcher is in flight fences this write out (H-5): the fresh
  // value is never written back to the logged-out identity's cache.
  const gen = cacheGeneration();
  const job = (async (): Promise<T | undefined> => {
    try {
      const fresh = await fetcher();
      cacheSet(key, fresh, atOf ? atOf(fresh) : undefined, scope, gen);
      apply(fresh, "network");
      lastRefreshAt.set(dk, Date.now());
      return fresh;
    } catch {
      // Background refresh failure is silent — the cached paint stands, and the
      // next trigger (poll, remount past TTL) retries.
      return undefined;
    } finally {
      inflight.delete(dk);
    }
  })();
  inflight.set(dk, job);
  const fresh = await job;
  return fresh ?? cached?.data;
}

/** Test-only: clear dedupe/TTL bookkeeping between cases. */
export function __resetSwrForTests(): void {
  inflight.clear();
  lastRefreshAt.clear();
}
