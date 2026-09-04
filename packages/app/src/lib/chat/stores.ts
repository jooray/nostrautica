/**
 * Marmot MLS state persistence (MARMOT-GROUP-CHAT §5, Phase 2).
 *
 * marmot-ts persists all client state through `GenericKeyValueStore<T>`
 * (getItem/setItem/removeItem/clear/keys). No production browser adapter ships
 * (in-memory + demo-only), so this is our IndexedDB implementation
 * (`UPSTREAM U1`: contribute a browser adapter to marmot-ts `/extra`).
 *
 * Design notes:
 *  - **Storage-agnostic core.** All namespacing/prefix logic lives in
 *    `namespacedStore`, driven by a tiny {@link MarmotKvBackend}. The production
 *    backend is IndexedDB ({@link IndexedDbKvBackend}); tests drive the identical
 *    logic through {@link InMemoryKvBackend}, so the namespacing contract is
 *    verified without a headless-browser IndexedDB shim.
 *  - **Per-identity namespacing (§5).** Every logical store is keyed under the
 *    active chat-identity pubkey, so a device that logs into two accounts (each
 *    with its own chat identity) never cross-contaminates MLS state. `clear()`
 *    only clears the calling store's namespace, never the whole DB.
 *  - **Values are structured-clone-able.** marmot's state (`SerializedClientState`,
 *    `StoredKeyPackage`, `StoredInviteEntry`) and the rewind tree (`Uint8Array`)
 *    all survive IndexedDB structured clone directly — no manual (de)serialization.
 *    This IndexedDB material is the same secret class and the same accepted risk as
 *    the existing `local-sk` keystore (SPECIFICATION.md §14).
 */
import type { GenericKeyValueStore } from "@internet-privacy/marmot-ts/utils";
import type { SerializedClientState } from "@internet-privacy/marmot-ts/core";
import type { StoredKeyPackage, StoredInviteEntry } from "@internet-privacy/marmot-ts/client";
import { makeKeyValueRumorHistoryFactory } from "@internet-privacy/marmot-ts/extra";

/** Unit-separator between identity, namespace, and the user key (never in a hex/base64 key). */
const SEP = "\x1f";

/** The full-key prefix `namespacedStore` uses for everything under one chat identity. */
export function identityPrefix(identity: string): string {
  return `${identity}${SEP}`;
}

/** The four logical stores a `MarmotClient` needs (§5), namespaced per identity. */
export const MARMOT_NAMESPACES = {
  groupState: "group-state",
  keyPackage: "key-package",
  invites: "invites",
  rewind: "rewind",
  // Decrypted-message history is further sub-namespaced per group (`history:<id>`).
  history: "history",
  // Event-coordinate → nostr_group_id binding (APPK-3 event scoping), one per event.
  eventGroups: "event-groups",
} as const;

/**
 * Minimal key/value backend the namespaced stores drive. Full (already-prefixed)
 * string keys; opaque structured-clone-able values. Deliberately tiny so an
 * in-memory test double and the IndexedDB implementation are trivially exchangeable.
 */
export interface MarmotKvBackend {
  get(fullKey: string): Promise<unknown>;
  set(fullKey: string, value: unknown): Promise<void>;
  del(fullKey: string): Promise<void>;
  /** All stored full keys that begin with `prefix`. */
  keysWithPrefix(prefix: string): Promise<string[]>;
  /** Delete every stored key that begins with `prefix`. */
  clearPrefix(prefix: string): Promise<void>;
}

/**
 * Wrap a backend as a marmot `GenericKeyValueStore<T>` scoped to
 * `<identity>␟<namespace>␟`. Keys the caller sees are un-prefixed; the prefix is
 * applied/stripped here.
 */
export function namespacedStore<T>(
  backend: MarmotKvBackend,
  identity: string,
  namespace: string,
): GenericKeyValueStore<T> {
  const prefix = `${identity}${SEP}${namespace}${SEP}`;
  return {
    async getItem(key: string): Promise<T | null> {
      const value = await backend.get(prefix + key);
      // marmot's contract is `T | null`; a missing item is null, never undefined.
      return value === undefined || value === null ? null : (value as T);
    },
    async setItem(key: string, value: T): Promise<T> {
      await backend.set(prefix + key, value);
      return value;
    },
    async removeItem(key: string): Promise<void> {
      await backend.del(prefix + key);
    },
    async clear(): Promise<void> {
      await backend.clearPrefix(prefix);
    },
    async keys(): Promise<string[]> {
      const full = await backend.keysWithPrefix(prefix);
      return full.map((k) => k.slice(prefix.length));
    },
  };
}

/** The bundle of typed stores a `MarmotClient` is constructed with (§2 integration surface). */
export interface MarmotStores {
  groupStateStore: GenericKeyValueStore<SerializedClientState>;
  keyPackageStore: GenericKeyValueStore<StoredKeyPackage>;
  inviteStore: GenericKeyValueStore<StoredInviteEntry>;
  rewindStore: GenericKeyValueStore<Uint8Array>;
  /**
   * Event-coordinate → nostr_group_id (hex) bindings recorded at join time
   * (audit APPK-3). MLS group state is namespaced per IDENTITY, not per event,
   * so without this mapping two chat-enabled events would share one pool of
   * joined groups — and `loadAll()[0]` could route a message to the wrong
   * event's room. Written only for coordinator-verified joins (audit APPK-2).
   */
  eventGroupStore: GenericKeyValueStore<string>;
}

/** Build the four typed marmot stores for one chat identity over a backend. */
export function makeMarmotStores(backend: MarmotKvBackend, identity: string): MarmotStores {
  return {
    groupStateStore: namespacedStore(backend, identity, MARMOT_NAMESPACES.groupState),
    keyPackageStore: namespacedStore(backend, identity, MARMOT_NAMESPACES.keyPackage),
    inviteStore: namespacedStore(backend, identity, MARMOT_NAMESPACES.invites),
    rewindStore: namespacedStore(backend, identity, MARMOT_NAMESPACES.rewind),
    eventGroupStore: namespacedStore(backend, identity, MARMOT_NAMESPACES.eventGroups),
  };
}

/** Lowercase hex of a byte array (for the per-group history namespace). */
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * A durable decrypted-message history factory for the MarmotClient (§5 message
 * persistence). marmot auto-saves every application message it ingests OR sends
 * into `group.history`; backing that with IndexedDB (one namespace per group,
 * under this chat identity) is what makes past + while-offline messages survive a
 * navigation/reload — without it, `messages` lived only in the page's memory and
 * every chat re-open started blank. Each rumor is keyed by its own id, so relay
 * backfill re-ingesting the same message overwrites in place instead of dup'ing.
 */
export function makeMarmotHistoryFactory(backend: MarmotKvBackend, identity: string) {
  return makeKeyValueRumorHistoryFactory((groupId) =>
    namespacedStore(backend, identity, `${MARMOT_NAMESPACES.history}:${toHex(groupId)}`),
  );
}

// ── In-memory backend (tests + the marmot in-memory parity path) ──────────────
/** A `Map`-backed {@link MarmotKvBackend}. Deep-clones on write so callers can't
 *  mutate stored state by reference (matching IndexedDB structured-clone semantics). */
export class InMemoryKvBackend implements MarmotKvBackend {
  private readonly map = new Map<string, unknown>();

  async get(fullKey: string): Promise<unknown> {
    return this.map.has(fullKey) ? clone(this.map.get(fullKey)) : undefined;
  }
  async set(fullKey: string, value: unknown): Promise<void> {
    this.map.set(fullKey, clone(value));
  }
  async del(fullKey: string): Promise<void> {
    this.map.delete(fullKey);
  }
  async keysWithPrefix(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
  async clearPrefix(prefix: string): Promise<void> {
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k);
  }
}

/** structuredClone where available (browser + Node ≥17), else a JSON/byte fallback. */
function clone<T>(v: T): T {
  if (typeof structuredClone === "function") return structuredClone(v);
  if (v instanceof Uint8Array) return new Uint8Array(v) as unknown as T;
  return JSON.parse(JSON.stringify(v)) as T;
}

// ── IndexedDB backend (production) ────────────────────────────────────────────
const DB_NAME = "nostrautica-marmot";
const STORE = "kv";

/**
 * ONE connection for the whole tab, opened lazily and reused.
 *
 * This used to be a fresh `indexedDB.open` per operation, with a `close()` in a
 * `finally`. Opening is not free — it is a round trip to the storage thread — and
 * marmot drives one operation per MLS state read/write, so the logout wipe
 * (`clearPrefix` over every namespace, after a `keysWithPrefix` scan) paid for an
 * open per key. Holding one connection also gives us somewhere to put the
 * `versionchange` handler below, which per-operation connections cannot have.
 */
let connection: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  return (connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    // `blocked` fires when ANOTHER tab holds an open connection at an older
    // version and won't let this upgrade through. Without a handler the promise
    // simply never settles and every chat operation hangs forever with no error —
    // the browser's own console warning is the only sign. Reject instead: the
    // caller's catch surfaces it, and the next call re-opens (the other tab's
    // `versionchange` handler below closes it, so a retry succeeds).
    req.onblocked = () => {
      connection = undefined;
      reject(new Error("marmot IndexedDB upgrade blocked by another tab"));
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab is upgrading: close so it can proceed, and drop the cached
      // connection so the next operation re-opens at the new version. Keeping it
      // open is what makes the OTHER tab's `blocked` fire.
      db.onversionchange = () => {
        connection = undefined;
        db.close();
      };
      // A connection can also be closed out from under us (storage eviction,
      // devtools "clear site data"). Forget it so we re-open rather than throwing
      // InvalidStateError on every subsequent transaction.
      db.onclose = () => {
        connection = undefined;
      };
      resolve(db);
    };
    req.onerror = () => {
      connection = undefined;
      reject(req.error);
    };
  }));
}

/** IndexedDB {@link MarmotKvBackend}: one keyed object store; prefix scans use a
 *  bounded key range (`[prefix, prefix+￿)`) rather than a full-store scan. */
export class IndexedDbKvBackend implements MarmotKvBackend {
  /**
   * Run one request and resolve only once its TRANSACTION has committed.
   *
   * The previous version resolved on `req.onsuccess` and never looked at the
   * transaction. A request succeeding means the value was staged, not durable:
   * IndexedDB delivers a commit-time failure — disk pressure, some quota paths, a
   * `QuotaExceededError` raised while flushing — to the TRANSACTION as `abort`,
   * long after every request in it reported success. So `setItem` resolved, marmot
   * recorded the new MLS epoch as persisted, and it was not. The next load restores
   * the previous epoch and every message from the missing one is undecryptable —
   * which looks exactly like the eviction bug the rejoin path exists to fix, except
   * rejoining doesn't help because the write will fail the same way next time.
   *
   * `oncomplete` is the only event that means "committed". Reads go through the
   * same path deliberately: it costs one extra event turn, and a read that resolves
   * from an aborted transaction is a value that was never really there.
   */
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await openDb();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      let result: T;
      let failed: unknown;
      const req = fn(transaction.objectStore(STORE));
      req.onsuccess = () => {
        result = req.result;
      };
      // Record it, but do NOT settle here: a request error that goes unprevented
      // aborts the transaction, and `onabort` below is the authoritative signal.
      // Settling early would let a rejected caller race a still-live transaction.
      req.onerror = () => {
        failed ??= req.error ?? new Error("marmot IndexedDB request failed");
      };
      transaction.oncomplete = () =>
        failed ? reject(failed) : resolve(result as T);
      transaction.onabort = () =>
        reject(failed ?? transaction.error ?? new Error("marmot IndexedDB transaction aborted"));
      transaction.onerror = () => {
        failed ??= transaction.error ?? new Error("marmot IndexedDB transaction failed");
      };
    });
  }

  async get(fullKey: string): Promise<unknown> {
    const v = await this.tx("readonly", (s) => s.get(fullKey));
    return v === undefined ? undefined : v;
  }
  async set(fullKey: string, value: unknown): Promise<void> {
    await this.tx("readwrite", (s) => s.put(value, fullKey));
  }
  async del(fullKey: string): Promise<void> {
    await this.tx("readwrite", (s) => s.delete(fullKey));
  }
  async keysWithPrefix(prefix: string): Promise<string[]> {
    const range = IDBKeyRange.bound(prefix, prefix + "￿", false, true);
    const keys = await this.tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys(range));
    return keys.map((k) => String(k));
  }
  async clearPrefix(prefix: string): Promise<void> {
    const range = IDBKeyRange.bound(prefix, prefix + "￿", false, true);
    await this.tx("readwrite", (s) => s.delete(range));
  }
}

/**
 * Drop the cached IndexedDB connection (tests only). The connection is
 * module-level by design — one per tab — which means a test that wants a fresh
 * `indexedDB.open` needs a way to say so.
 */
export function __resetMarmotIdbConnectionForTests(): void {
  connection = undefined;
}

/** The shared production backend (one IndexedDB DB for all chat identities). */
let sharedBackend: MarmotKvBackend | undefined;
export function marmotKvBackend(): MarmotKvBackend {
  return (sharedBackend ??= new IndexedDbKvBackend());
}

/** Swap the shared backend (tests only, no IndexedDB in the test env). Pass
 *  `null` to restore the production IndexedDB backend. */
export function __setMarmotKvBackendForTests(b: MarmotKvBackend | null): void {
  sharedBackend = b ?? undefined;
}

/** Convenience: the four production stores for a chat identity, IndexedDB-backed. */
export function openMarmotStores(identity: string): MarmotStores {
  return makeMarmotStores(marmotKvBackend(), identity);
}
