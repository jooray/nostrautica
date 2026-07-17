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

/** Unit-separator between identity, namespace, and the user key (never in a hex/base64 key). */
const SEP = "\x1f";

/** The four logical stores a `MarmotClient` needs (§5), namespaced per identity. */
export const MARMOT_NAMESPACES = {
  groupState: "group-state",
  keyPackage: "key-package",
  invites: "invites",
  rewind: "rewind",
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
}

/** Build the four typed marmot stores for one chat identity over a backend. */
export function makeMarmotStores(backend: MarmotKvBackend, identity: string): MarmotStores {
  return {
    groupStateStore: namespacedStore(backend, identity, MARMOT_NAMESPACES.groupState),
    keyPackageStore: namespacedStore(backend, identity, MARMOT_NAMESPACES.keyPackage),
    inviteStore: namespacedStore(backend, identity, MARMOT_NAMESPACES.invites),
    rewindStore: namespacedStore(backend, identity, MARMOT_NAMESPACES.rewind),
  };
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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** IndexedDB {@link MarmotKvBackend}: one keyed object store; prefix scans use a
 *  bounded key range (`[prefix, prefix+￿)`) rather than a full-store scan. */
export class IndexedDbKvBackend implements MarmotKvBackend {
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await openDb();
    try {
      return await new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
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

/** The shared production backend (one IndexedDB DB for all chat identities). */
let sharedBackend: MarmotKvBackend | undefined;
export function marmotKvBackend(): MarmotKvBackend {
  return (sharedBackend ??= new IndexedDbKvBackend());
}

/** Convenience: the four production stores for a chat identity, IndexedDB-backed. */
export function openMarmotStores(identity: string): MarmotStores {
  return makeMarmotStores(marmotKvBackend(), identity);
}
