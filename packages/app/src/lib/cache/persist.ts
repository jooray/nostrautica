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

/** A stored value: the derived data plus the newest `created_at` it came from. */
export interface CacheEntry<T = unknown> {
  at: number;
  data: T;
}

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
  put(compositeKey: string, entry: CacheEntry): Promise<void>;
  delete(compositeKeys: string[]): Promise<void>;
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
      tx.objectStore(STORE).put(entry, compositeKey);
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
  hydrating = new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      hydrated = true;
      hydrating = null;
      resolve();
    };
    // Bound: never let a slow/broken IDB block boot.
    const timer = setTimeout(done, 1500);
    (async () => {
      if (!backend) return;
      const all = await backend.getAll();
      for (const [k, v] of all) {
        if (v && typeof v.at === "number") mirror.set(k, v);
      }
    })()
      .catch(() => {
        /* IDB unavailable — mirror stays empty, app degrades to no-cache */
      })
      .finally(() => {
        clearTimeout(timer);
        done();
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
  return mirror.get(compositeKey(s, key)) as CacheEntry<T> | undefined;
}

/**
 * Mirror write + fire-and-forget IDB put. Latest-wins: only overwrites when
 * `at >= stored.at`. `at` defaults to now (seconds) for data with no natural
 * event timestamp. Owner-scoped writes with no active identity are a silent
 * no-op (paint-only layer, never throws).
 */
export function cacheSet<T>(key: string, data: T, at?: number, scope?: string): void {
  const s = resolveScope(scope);
  if (s === null) return;
  const ck = compositeKey(s, key);
  const stamp = at ?? Math.floor(Date.now() / 1000);
  const existing = mirror.get(ck);
  if (existing && existing.at > stamp) return; // never overwrite newer with older
  const entry: CacheEntry<T> = { at: stamp, data };
  mirror.set(ck, entry);
  void backend?.put(ck, entry as CacheEntry).catch(() => {
    /* best-effort persistence; the mirror is authoritative for this session */
  });
}

/** Remove one entry (mirror + IDB). */
export function cacheDelete(key: string, scope?: string): void {
  const s = resolveScope(scope);
  if (s === null) return;
  const ck = compositeKey(s, key);
  mirror.delete(ck);
  void backend?.delete([ck]).catch(() => {});
}

/**
 * Wipe every entry filed under one owner (§3.1). Called by `session.logout()`
 * next to `setActiveOwner(null)` so a logout leaves no decrypted copies behind.
 * Anon (public) entries are untouched.
 */
export function clearOwnerCache(owner: string): void {
  const prefix = `${owner}${SEP}`;
  const keys: string[] = [];
  for (const k of mirror.keys()) if (k.startsWith(prefix)) keys.push(k);
  for (const k of keys) mirror.delete(k);
  void backend?.delete(keys).catch(() => {});
}

/**
 * Drop entries older than 30 days (§3.5). Runs on an idle callback after
 * hydration; best-effort. Bounded stores (DM/inbox wrap memos) self-cap in
 * their own modules.
 */
export async function pruneCache(): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  const keys: string[] = [];
  for (const [k, v] of mirror) if (v.at < cutoff) keys.push(k);
  for (const k of keys) mirror.delete(k);
  if (backend) await backend.delete(keys).catch(() => {});
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
  activeOwner = null;
}
