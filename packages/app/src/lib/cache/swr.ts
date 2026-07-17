/**
 * One stale-while-revalidate helper (CACHING-PLAN §1.2) built on persist.ts.
 *
 * Paint from the persistent cache synchronously, refresh from relays in the
 * background, apply the fresh value reactively. In-flight refreshes are deduped
 * per key (like prefetch.ts's `warm()`), and a short TTL keeps a remount from
 * re-hitting relays. Background refreshes never throw to the caller.
 */
import { cacheGet, cacheSet } from "./persist.js";

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
// a remount within `ttlMs` is a no-op (matches prefetch.ts semantics).
const inflight = new Map<string, Promise<unknown>>();
const lastRefreshAt = new Map<string, number>();

const DEFAULT_TTL_MS = 15_000;

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

  // Fresh enough / already refreshing: don't hit relays again.
  const last = lastRefreshAt.get(key);
  if (last !== undefined && Date.now() - last < ttlMs) return cached?.data;
  const running = inflight.get(key) as Promise<T | undefined> | undefined;
  if (running) return running.then((v) => v ?? cached?.data);

  const job = (async (): Promise<T | undefined> => {
    try {
      const fresh = await fetcher();
      cacheSet(key, fresh, atOf ? atOf(fresh) : undefined, scope);
      apply(fresh, "network");
      lastRefreshAt.set(key, Date.now());
      return fresh;
    } catch {
      // Background refresh failure is silent — the cached paint stands, and the
      // next trigger (poll, remount past TTL) retries.
      return undefined;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  const fresh = await job;
  return fresh ?? cached?.data;
}

/** Test-only: clear dedupe/TTL bookkeeping between cases. */
export function __resetSwrForTests(): void {
  inflight.clear();
  lastRefreshAt.clear();
}
