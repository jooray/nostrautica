/**
 * Persistent app cache: a KV store (IndexedDB) with a synchronous in-memory
 * mirror (CACHING-PLAN §1.1). Every derived/decrypted view model the app used to
 * keep only in a session-lifetime Map (directory entries, posts, matches, talks,
 * DM plaintexts, roles, readiness…) becomes a view over this store, so a reload
 * or fresh navigation paints instantly from cache while relays refresh in the
 * background — no page ever waits on a relay round-trip for data it has seen.
 *
 * SCOPING (mirrors keystore.ts's owner model): every entry is filed under a
 * `scope` — either the literal "anon" for public data (event contexts, kind-0
 * profiles, public posts, themes, coordinator announcements) or the logged-in
 * identity's pubkey ("owner") for anything decrypted with user/event keys
 * (roster, directory, matches, members posts, DMs, settings, follows, mutes,
 * pending queues, readiness, roles). Owner-scoped reads/writes resolve against
 * the active owner set by the session on login/restore/logout
 * (`setActiveCacheOwner`, wired next to keystore's `setActiveOwner`), exactly
 * like keystore. `session.logout()` calls `clearOwnerCache(owner)` so a logout
 * wipes every decrypted copy for that identity.
 *
 * LATEST-WINS (§3.2): each entry carries the newest `created_at` it was derived
 * from as `at`; a write only lands if `at >= stored.at`, so a background refresh
 * racing a prefetch can never overwrite newer data with older — matching Nostr
 * replaceable-event semantics.
 *
 * PRIVACY (§1.1): decrypted event content at rest in IndexedDB is the same risk
 * class as the ECK / `local-sk` already persisted there (SPECIFICATION.md §14).
 * DM plaintexts are persisted owner-scoped and wiped on logout — the same
 * accepted class. Nothing here is a new secret-at-rest category.
 *
 * The IndexedDB access is behind an injectable backend seam (copied from
 * keystore.ts) so unit tests exercise the mirror/latest-wins/scoping/prune logic
 * with an in-memory backend (the test env has no IndexedDB).
 */

import { cacheHydration } from "./hydration.svelte.js";

/**
 * A stored value carrying TWO independent clocks, which is the whole point:
 *
 * - `at` is the newest `created_at` the data was derived from. It drives
 *   latest-wins and must stay tied to the source event.
 * - `touchedAt` is wall-clock seconds at the last write or read. It drives
 *   eviction, and nothing else may.
 *
 * They were one field until 2026-09-04, and conflating them silently disabled the
 * cache for the data it exists to serve: most writers stamp `at` with the source
 * event's timestamp (see event-context.ts, attendee.ts, social.ts), so an event
 * configured two months before it happens looked 60 days stale the moment it was
 * cached, and the 30-day prune deleted its context, roster, directory and every
 * profile on the next boot. Forever, because the next boot re-fetched and
 * re-stamped them with the same old `created_at`.
 *
 * `touchedAt` is optional only for entries written by a pre-split build; those are
 * treated as freshly touched rather than as ancient (see {@link pruneCache}).
 */
export interface CacheEntry<T = unknown> {
  at: number;
  touchedAt?: number;
  data: T;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Public scope for data that isn't decrypted with user/event keys. */
export const ANON = "anon";

/** Field separator between scope and key in the composite IDB key (§1.1). */
const SEP = "\x1f";

function compositeKey(scope: string, key: string): string {
  return `${scope}${SEP}${key}`;
}

// ── Active owner (mirrors keystore.setActiveOwner) ───────────────────────────

let activeOwner: string | null = null;

/**
 * Set by the session on login/restore/logout so owner-scoped reads/writes file
 * under the current identity. Wired next to keystore's `setActiveOwner`.
 */
export function setActiveCacheOwner(pubkey: string | null): void {
  activeOwner = pubkey;
}

/**
 * The current owner, or null when logged out. For modules whose data is
 * owner-scoped when logged in and anon otherwise (e.g. posts.ts §2.4):
 * `scope = activeCacheOwner() ?? ANON`.
 */
export function activeCacheOwner(): string | null {
  return activeOwner;
}

/**
 * Resolve the scope for a call: an explicit scope wins ("anon" or an explicit
 * owner, as tests pass); otherwise the active owner. Returns null when an
 * owner-scoped read/write happens with no logged-in identity — the caller then
 * treats it as a cache miss / no-op (paint-only layer, never throws).
 */
function resolveScope(explicit?: string): string | null {
  return explicit ?? activeOwner;
}

// ── Storage backend seam (production = IndexedDB; tests inject in-memory) ─────

export interface PersistBackend {
  /** One bulk read at boot. */
  getAll(): Promise<Array<[string, CacheEntry]>>;
  /**
   * Versioned put (App-6): the write lands only if the incoming `at` is >= the
   * value already on disk, compared INSIDE the transaction. This makes disk
   * latest-wins across tabs — tab A's stale fire-and-forget write can no longer
   * regress tab B's newer disk state, because A's older `at` loses the on-disk
   * compare even though A's in-memory mirror never saw B's newer value.
   */
  put(compositeKey: string, entry: CacheEntry): Promise<void>;
  delete(compositeKeys: string[]): Promise<void>;
  /**
   * Delete every key under an owner prefix in ONE transaction (H-5). Deletes by
   * key RANGE, not by a list the caller enumerated, so a foreign tab's
   * owner-scoped writes — absent from this tab's in-memory mirror — die too.
   * Optional so the lightweight in-memory test backends need not implement it;
   * `clearOwnerCache` falls back to mirror-known keys when it is missing.
   */
  deleteByPrefix?(prefix: string): Promise<void>;
}

const DB_NAME = "nostrautica-appcache";
const DB_VERSION = 1;
const STORE = "kv";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqAsync<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const indexedDbBackend: PersistBackend = {
  async getAll() {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readonly");
      const os = tx.objectStore(STORE);
      const [keys, values] = await Promise.all([
        reqAsync(os.getAllKeys()),
        reqAsync(os.getAll()),
      ]);
      const out: Array<[string, CacheEntry]> = [];
      for (let i = 0; i < keys.length; i++) {
        out.push([keys[i] as string, values[i] as CacheEntry]);
      }
      return out;
    } finally {
      db.close();
    }
  },
  async put(compositeKey, entry) {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      const os = tx.objectStore(STORE);
      // Read-modify-write inside the transaction (App-6): compare the on-disk
      // `at` and skip the write when this value is older, so a stale cross-tab
      // write can't regress newer disk state.
      const existing = (await reqAsync(os.get(compositeKey))) as CacheEntry | undefined;
      if (!existing || entry.at >= existing.at) os.put(entry, compositeKey);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
  async delete(compositeKeys) {
    if (compositeKeys.length === 0) return;
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      const os = tx.objectStore(STORE);
      for (const k of compositeKeys) os.delete(k);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
  async deleteByPrefix(prefix) {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      const os = tx.objectStore(STORE);
      // Half-open range [prefix, prefix + <0xFFFF sentinel>) covers exactly the
      // keys beginning with `prefix` (the composite key is `${owner}\x1f${key}`).
      const range = IDBKeyRange.bound(prefix, prefix + "￿", false, false);
      os.delete(range);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
};

let backend: PersistBackend | null =
  typeof indexedDB !== "undefined" ? indexedDbBackend : null;

/** Swap the storage backend (tests only). Pass null to restore IndexedDB. */
export function __setPersistBackend(b: PersistBackend | null): void {
  backend = b ?? (typeof indexedDB !== "undefined" ? indexedDbBackend : null);
}

// ── In-memory mirror + public API ────────────────────────────────────────────

const mirror = new Map<string, CacheEntry>();

let hydrated = false;
let hydrating: Promise<void> | null = null;

/**
 * Resolved when the boot bulk read has ACTUALLY folded IndexedDB into the mirror
 * — which is a different moment from `hydrateAppCache()` resolving.
 *
 * `hydrateAppCache()` is bounded at 1500 ms on purpose: boot must not wait for a
 * slow disk. But that bound resolves the boot promise (and bumps
 * `cacheHydration`) while the mirror may still be COMPLETELY COLD, and a cold
 * mirror is indistinguishable from an empty one. For a snapshot — a roster, an
 * event context — reading it early is harmless: you paint nothing and re-read on
 * the next bump.
 *
 * For an ACCUMULATED record it is not harmless, and this is the bug it exists to
 * stop (user report 2026-09-18). Three DM records accumulate: the per-wrap
 * unwrap memo, the inbox scan cursor, and the per-peer read watermarks. Reading
 * any of them cold yields "nothing decrypted, nothing scanned, nothing read",
 * and the write that follows carries `at = now`, which beats the real record
 * both in the mirror (`cacheSet`) and on disk (the versioned `put`). So a cold
 * read didn't just paint an empty badge — it DELETED the history it failed to
 * see. Every reload re-walked DM history from scratch and every already-read
 * message counted as unread until the mirror caught up.
 *
 * Callers that accumulate therefore await this instead. All of them are already
 * behind a relay round-trip, so the wait is free in practice.
 */
let mirrorReady: Promise<void> | null = null;
let markMirrorReady: (() => void) | null = null;
let mirrorSettled = false;

/** Upper bound on `whenCacheReady`, so a wedged IDB can't block a caller forever. */
const MIRROR_READY_BOUND_MS = 8_000;

/**
 * Await the real bulk read (bounded). Resolves immediately once it has landed,
 * and immediately when there is no backend to read (SSR, tests, IDB disabled).
 *
 * Use this — not `hydrateAppCache()` — before reading a cache record that the
 * app then writes BACK in full, where "not there yet" and "not there" would
 * produce the same, destructive, write.
 */
export function whenCacheReady(): Promise<void> {
  if (cacheIsReady()) return Promise.resolve();
  if (!mirrorReady) {
    mirrorReady = new Promise<void>((resolve) => {
      const bound = setTimeout(resolve, MIRROR_READY_BOUND_MS);
      markMirrorReady = () => {
        clearTimeout(bound);
        resolve();
      };
    });
    // Idempotent: a caller that gets here before boot did still starts the read.
    void hydrateAppCache();
  }
  return mirrorReady;
}

/**
 * The same question as `whenCacheReady`, asked synchronously — for the reactive
 * paths that must decide what to render THIS tick rather than await. True when
 * the bulk read has landed, and true when there is no store to read at all.
 */
export function cacheIsReady(): boolean {
  return !backend || mirrorSettled;
}

/**
 * Owner-cache generation (H-5). Bumped every time owner-scoped state is
 * invalidated (logout / `clearOwnerCache`). A hydration or asynchronous cache
 * write that STARTED before a logout but only COMPLETES after it must not
 * repopulate memory or disk with the logged-out identity's plaintext — so those
 * async paths capture the generation up front and drop their result if it has
 * since advanced.
 */
let generation = 0;

/** The current owner-cache generation. Capture before an async op, re-check after. */
export function cacheGeneration(): number {
  return generation;
}

// ── Size budget + quota reporting ────────────────────────────────────────────

/**
 * Why this exists at all (2026-09-04): the IDB put was `.catch(() => {})`, and
 * the ONE error it is guaranteed to see eventually is `QuotaExceededError`. Once
 * a heavy user's origin quota filled, every write failed silently while the
 * in-memory mirror kept happily reporting the data as cached — so the app
 * behaved perfectly all session and started stone cold on every subsequent boot,
 * forever, with nothing logged anywhere. `pruneCache` could not dig them out
 * either: it was age-only, so a cache full of entries touched this week was
 * exactly as unprunable as it was unwritable.
 *
 * The budget is deliberately coarse. Origin quota is a browser-decided fraction
 * of free disk that this code cannot query cheaply or portably, so the cap is a
 * self-imposed ceiling well under any plausible allowance — the point is to stop
 * unbounded growth, not to track the real limit.
 */
let MAX_CACHE_ENTRIES = 4_000;
let MAX_CACHE_BYTES = 8 * 1024 * 1024;

/**
 * Approximate serialized size per entry, memoized on the entry OBJECT (a
 * WeakMap, so nothing is persisted and a replaced entry's measurement is
 * collected with it). `JSON.stringify` on a hot write path would be absurd; the
 * measurement happens once per stored value and is reused by every later budget
 * pass.
 */
const entryBytes = new WeakMap<CacheEntry, number>();

function approxBytes(entry: CacheEntry): number {
  const known = entryBytes.get(entry);
  if (known !== undefined) return known;
  let n = 0;
  try {
    n = JSON.stringify(entry.data)?.length ?? 0;
  } catch {
    // Circular or non-serializable: it can't reach IDB either, so it costs
    // nothing on disk. Count a nominal size so it still ages out normally.
    n = 0;
  }
  n += 96; // composite key + envelope + IDB record overhead, roughly
  entryBytes.set(entry, n);
  return n;
}

/** Running approximation of the mirror's on-disk cost; re-derived on each pass. */
let mirrorBytes = 0;

function recountMirrorBytes(): number {
  let total = 0;
  for (const v of mirror.values()) total += approxBytes(v);
  mirrorBytes = total;
  return total;
}

/**
 * True when persistence is known to be failing — the browser refused a write for
 * lack of space. The mirror still answers reads for THIS session, so the app is
 * not broken; the next boot is simply cold. Exposed so a caller can say so
 * rather than leaving the user with an app that is mysteriously slow every
 * morning.
 */
let quotaExceeded = false;

export function cachePersistenceDegraded(): boolean {
  return quotaExceeded;
}

/** Entry/byte counts for diagnostics (and for the eviction tests). */
export function cacheStats(): { entries: number; bytes: number; quotaExceeded: boolean } {
  return { entries: mirror.size, bytes: recountMirrorBytes(), quotaExceeded };
}

function isQuotaError(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown } | null;
  // Firefox uses the legacy `NS_ERROR_DOM_QUOTA_REACHED` name; DOMException code
  // 22 is the pre-name spelling still emitted by older Safari.
  return (
    !!e &&
    (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.code === 22)
  );
}

/**
 * Drop least-recently-USED entries until the mirror is inside the budget, and
 * mirror the deletions to disk. `touchedAt` is the eviction clock (never `at` —
 * see the CacheEntry docs), so what goes first is what nothing has read or
 * rewritten for the longest, which is exactly the data whose absence costs the
 * least. Returns how many entries were evicted.
 */
function enforceCacheBudget(): number {
  let bytes = recountMirrorBytes();
  if (mirror.size <= MAX_CACHE_ENTRIES && bytes <= MAX_CACHE_BYTES) return 0;
  const byAge = [...mirror.entries()].sort(
    (a, b) => (a[1].touchedAt ?? 0) - (b[1].touchedAt ?? 0),
  );
  const evicted: string[] = [];
  for (const [k, v] of byAge) {
    if (mirror.size - evicted.length <= MAX_CACHE_ENTRIES && bytes <= MAX_CACHE_BYTES) break;
    evicted.push(k);
    bytes -= approxBytes(v);
  }
  for (const k of evicted) mirror.delete(k);
  mirrorBytes = bytes;
  if (evicted.length && backend) void backend.delete(evicted).catch(() => {});
  return evicted.length;
}

/** Coalesce budget passes so a write burst schedules at most one sweep. */
let budgetScheduled = false;

function scheduleBudgetCheck(): void {
  if (budgetScheduled) return;
  budgetScheduled = true;
  scheduleIdle(() => {
    budgetScheduled = false;
    enforceCacheBudget();
  });
}

/**
 * One bulk read at boot to fill the synchronous mirror. Bounded (§1.1): resolves
 * after 1500 ms even if IDB is slow/broken — the mirror simply stays (partly)
 * empty and the app works exactly as it did before this cache existed.
 *
 * Call in `+layout.svelte onMount` BEFORE `booted = true`, so every page's
 * `cachedX()` helper is warm on first render.
 */
export function hydrateAppCache(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (hydrating) return hydrating;
  const startGen = generation;
  hydrating = new Promise<void>((resolve) => {
    let settled = false;
    /**
     * Unblock BOOT. Deliberately separate from the wake-up signal below, which
     * is not one-shot.
     */
    const settleBoot = () => {
      if (settled) return;
      settled = true;
      hydrated = true;
      hydrating = null;
      resolve();
    };
    // Bound: never let a slow/broken IDB block boot. The bound fires exactly on
    // the devices this cache matters most for (old phones, contended storage) —
    // and until 2026-09-04 firing it LOST the wake-up: `done()` marked hydrated,
    // short-circuited on `settled`, and the real getAll then filled the mirror
    // with nobody left to tell. Pages that had already snapshotted the cold
    // mirror never re-read it, so the cache sat fully populated and completely
    // unused for that entire boot — the worst of both worlds, since it had
    // already cost the 1.5 s. `markHydrated()` is therefore called on BOTH
    // paths: once when boot gives up waiting, and again when the data actually
    // lands, because `cacheHydration.version` is what pages watch.
    const timer = setTimeout(() => {
      settleBoot();
      cacheHydration.markHydrated();
    }, 1500);
    (async () => {
      if (!backend) return;
      const all = await backend.getAll();
      // Generation fence (H-5): a logout that landed while this bulk read was in
      // flight bumped the generation. Do NOT repopulate the mirror with the
      // logged-out identity's owner-scoped plaintext; anon (public) entries are
      // safe to keep warming boot.
      const wiped = generation !== startGen;
      const anonPrefix = `${ANON}${SEP}`;
      for (const [k, v] of all) {
        if (!v || typeof v.at !== "number") continue;
        if (wiped && !k.startsWith(anonPrefix)) continue;
        // Backfill the eviction clock for entries written by a pre-split build, so
        // the first boot after the upgrade doesn't evict a warm cache on the very
        // `at` semantics the split exists to stop using.
        if (typeof v.touchedAt !== "number") v.touchedAt = nowSec();
        // LATEST WINS. Boot no longer awaits this bulk read (§7.4.5), so by the
        // time it lands the app has been running for up to 1.5 s and has very
        // likely written fresher entries — a just-fetched event context, a
        // submission's write-through. Overwriting those with what was on disk when
        // the read started paints stale data over fresh, and pages re-read on the
        // hydration version bump, so they actively pick the stale copy up. `at` is
        // the record's own recency (`touchedAt` is only the eviction clock), so
        // compare on that.
        const live = mirror.get(k);
        if (live && typeof live.at === "number" && live.at >= v.at) continue;
        mirror.set(k, v);
      }
      recountMirrorBytes();
    })()
      .catch(() => {
        /* IDB unavailable — mirror stays empty, app degrades to no-cache */
      })
      .finally(() => {
        clearTimeout(timer);
        settleBoot();
        // ALWAYS bump, even when the 1500 ms bound already marked boot hydrated:
        // that earlier signal described a mirror that was still cold.
        cacheHydration.markHydrated();
        // The mirror now says what the disk says. Release the callers that must
        // not read it before this point (see `whenCacheReady`).
        mirrorSettled = true;
        markMirrorReady?.();
        // Opportunistic prune once hydrated (idle; never blocks boot).
        scheduleIdle(() => void pruneCache());
      });
  });
  return hydrating;
}

/** Synchronous mirror read. undefined on miss or owner read with no identity. */
export function cacheGet<T>(key: string, scope?: string): CacheEntry<T> | undefined {
  const s = resolveScope(scope);
  if (s === null) return undefined;
  const entry = mirror.get(compositeKey(s, key)) as CacheEntry<T> | undefined;
  // Touch on read, in the MIRROR ONLY. An entry the app keeps reading is live and
  // must not age out, but this is a hot path — persisting here would put an IDB
  // write behind every cache read. The value reaches disk on the next `cacheSet`,
  // which SWR performs on every revalidation, so anything genuinely in use is
  // re-stamped on disk soon enough.
  if (entry) entry.touchedAt = nowSec();
  return entry;
}

/**
 * Mirror write + fire-and-forget IDB put. Latest-wins: only overwrites when
 * `at >= stored.at`. `at` defaults to now (seconds) for data with no natural
 * event timestamp. Owner-scoped writes with no active identity are a silent
 * no-op (paint-only layer, never throws).
 */
export function cacheSet<T>(
  key: string,
  data: T,
  at?: number,
  scope?: string,
  guardGeneration?: number,
): void {
  // Generation fence (H-5): an async producer (e.g. an swr fetcher) captures the
  // generation before it starts and passes it here; if a logout advanced the
  // generation meanwhile, drop the write so a slow refresh can't repopulate the
  // logged-out identity's plaintext in memory or on disk.
  if (guardGeneration !== undefined && guardGeneration !== generation) return;
  const s = resolveScope(scope);
  if (s === null) return;
  const ck = compositeKey(s, key);
  const stamp = at ?? Math.floor(Date.now() / 1000);
  const existing = mirror.get(ck);
  if (existing && existing.at > stamp) return; // never overwrite newer with older
  const entry: CacheEntry<T> = { at: stamp, touchedAt: nowSec(), data };
  mirror.set(ck, entry);
  mirrorBytes += approxBytes(entry) - (existing ? approxBytes(existing) : 0);
  if (mirror.size > MAX_CACHE_ENTRIES || mirrorBytes > MAX_CACHE_BYTES) scheduleBudgetCheck();
  void backend?.put(ck, entry as CacheEntry).catch((err: unknown) => {
    // Best-effort persistence — the mirror is authoritative for this session —
    // but a QUOTA failure is not a transient blip to swallow: it means every
    // later write fails too and every future boot is cold. Say so once, and free
    // space so the next write has somewhere to go.
    if (!isQuotaError(err)) return;
    if (!quotaExceeded) {
      quotaExceeded = true;
      console.warn(
        "[cache] IndexedDB is out of space: this session still reads from memory, " +
          "but nothing new is being persisted. Evicting least-recently-used entries.",
      );
    }
    if (enforceCacheBudget() === 0) {
      // Nothing left to evict at our own ceiling — the pressure is elsewhere in
      // the origin (Blossom blobs, the outbox, the keystore). Force a pass by
      // dropping the oldest tenth so the app is not permanently write-dead.
      const byAge = [...mirror.entries()].sort(
        (a, b) => (a[1].touchedAt ?? 0) - (b[1].touchedAt ?? 0),
      );
      const drop = byAge.slice(0, Math.ceil(byAge.length / 10)).map(([k]) => k);
      for (const k of drop) mirror.delete(k);
      recountMirrorBytes();
      if (drop.length && backend) void backend.delete(drop).catch(() => {});
    }
  });
}

/** Remove one entry (mirror + IDB). */
export function cacheDelete(key: string, scope?: string): void {
  const s = resolveScope(scope);
  if (s === null) return;
  const ck = compositeKey(s, key);
  const existing = mirror.get(ck);
  if (existing) mirrorBytes -= approxBytes(existing);
  mirror.delete(ck);
  void backend?.delete([ck]).catch(() => {});
}

/**
 * Wipe every entry filed under one owner (§3.1). Called by `session.logout()`
 * next to `setActiveOwner(null)` so a logout leaves no decrypted copies behind.
 * Anon (public) entries are untouched.
 */
export function clearOwnerCache(owner: string): void {
  // Bump the generation FIRST so any hydration/async write already in flight for
  // this identity is fenced out (H-5) — even if its completion races this wipe.
  generation++;
  const prefix = `${owner}${SEP}`;
  const keys: string[] = [];
  for (const k of mirror.keys()) if (k.startsWith(prefix)) keys.push(k);
  for (const k of keys) mirror.delete(k);
  recountMirrorBytes();
  // Delete by owner-prefix RANGE in one transaction (H-5): this removes keys
  // another tab wrote that never entered this tab's mirror, closing the leak
  // where a second tab's decrypted copy survived the first tab's logout. Fall
  // back to the mirror-known list only when the backend can't range-delete.
  if (backend?.deleteByPrefix) void backend.deleteByPrefix(prefix).catch(() => {});
  else void backend?.delete(keys).catch(() => {});
}

/**
 * Drop entries older than 30 days (§3.5). Runs on an idle callback after
 * hydration; best-effort. Bounded stores (DM/inbox wrap memos) self-cap in
 * their own modules.
 */
export async function pruneCache(): Promise<void> {
  const cutoff = nowSec() - 30 * 24 * 60 * 60;
  const keys: string[] = [];
  // `touchedAt`, never `at`: `at` is the source event's timestamp, so pruning on it
  // evicts a current record merely because the organizer published it a while ago.
  // A missing `touchedAt` (pre-split entry that hydration somehow didn't backfill)
  // means "no eviction evidence" and is kept, not deleted.
  for (const [k, v] of mirror) if ((v.touchedAt ?? nowSec()) < cutoff) keys.push(k);
  for (const k of keys) mirror.delete(k);
  if (backend) await backend.delete(keys).catch(() => {});
  // Age alone is not a bound. A heavy user reads everything they store, so
  // nothing ever gets old enough to prune and the store grows until the browser
  // starts refusing writes — silently, since the mirror keeps answering. The
  // size budget is what actually caps it (LRU by `touchedAt`).
  enforceCacheBudget();
}

/** Run `fn` when the browser is idle, or soon (test/SSR-safe fallback). */
function scheduleIdle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => void })
    .requestIdleCallback;
  if (typeof ric === "function") ric(fn);
  else setTimeout(fn, 2000);
}

/** Test-only: reset module state between cases. */
export function __resetPersistForTests(): void {
  mirror.clear();
  hydrated = false;
  hydrating = null;
  mirrorReady = null;
  markMirrorReady = null;
  mirrorSettled = false;
  activeOwner = null;
  generation = 0;
  mirrorBytes = 0;
  quotaExceeded = false;
  budgetScheduled = false;
}

/** Test-only: run the LRU size pass synchronously. Returns entries evicted. */
export function __enforceCacheBudgetForTests(): number {
  return enforceCacheBudget();
}

/**
 * Test-only: shrink the budget so eviction can be exercised without allocating
 * eight megabytes of fixture. Pass nothing to restore the production ceiling.
 */
export function __setCacheBudgetForTests(limits?: { entries?: number; bytes?: number }): void {
  MAX_CACHE_ENTRIES = limits?.entries ?? 4_000;
  MAX_CACHE_BYTES = limits?.bytes ?? 8 * 1024 * 1024;
}
