/**
 * Coordinator-side Marmot MLS state persistence (MARMOT-GROUP-CHAT §4.3, Phase 3).
 *
 * marmot-ts persists all client state through `GenericKeyValueStore<T>`
 * (getItem/setItem/removeItem/clear/keys). In the coordinator that state is the
 * group's ONLY admin material and must survive restarts, so it lives in SQLite —
 * and, being MLS private key material + group secrets, it is ENCRYPTED AT REST
 * under the coordinator identity key using the exact `Store.protect`/`reveal`
 * NIP-44 scheme the event-key columns already use (`marmot_kv` table).
 *
 * Two seams keep this testable and correct:
 *  - The {@link Store} owns the ciphertext: `marmotKvSet` NIP-44-encrypts the
 *    serialized value before it touches SQLite, `marmotKvGet` decrypts on read.
 *  - This module owns the value↔string codec. marmot's stored values are
 *    structured-clone data (nested `Uint8Array` key material, `bigint` epochs),
 *    which JSON cannot round-trip — {@link encodeValue}/{@link decodeValue} tag
 *    `Uint8Array` and `bigint` so the SQLite string column preserves them
 *    losslessly. `SerializedClientState`/rewind values are bare `Uint8Array`.
 */
import type { GenericKeyValueStore } from "@internet-privacy/marmot-ts/utils";
import type { SerializedClientState } from "@internet-privacy/marmot-ts/core";
import type { StoredKeyPackage, StoredInviteEntry } from "@internet-privacy/marmot-ts/client";
import type { Store } from "../store/db.js";
import { bytesToBase64, base64ToBytes } from "@nostrautica/protocol";

/** The four logical stores a `MarmotClient` needs (§4.3), one SQLite namespace each. */
export const MARMOT_NAMESPACES = {
  groupState: "group-state",
  keyPackage: "key-package",
  invites: "invites",
  rewind: "rewind",
} as const;

// ── structured-clone-safe string codec ───────────────────────────────────────
// marmot's stored values contain Uint8Array (MLS private keys, group state bytes)
// and may contain bigint (MLS epochs). JSON drops both, so we tag them. Tag
// objects use a reserved `$marmot` discriminator that a plain data object never
// carries, so decode is unambiguous.
type Tagged = { $marmot: "u8"; b64: string } | { $marmot: "bigint"; v: string };

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { $marmot: "u8", b64: bytesToBase64(value) } satisfies Tagged;
  }
  if (typeof value === "bigint") {
    return { $marmot: "bigint", v: value.toString() } satisfies Tagged;
  }
  return value;
}

function reviveTag(value: Tagged): Uint8Array | bigint {
  return value.$marmot === "u8" ? base64ToBytes(value.b64) : BigInt(value.v);
}

/**
 * Serialize a structured-clone value to a string, preserving `Uint8Array`/`bigint`.
 * `Uint8Array` is stored raw-tagged even at the top level (group-state values are
 * a bare `Uint8Array`) — the JSON `replacer` runs on `toJSON`-less values, but a
 * top-level `Uint8Array` is handled by wrapping first.
 */
export function encodeValue(value: unknown): string {
  return JSON.stringify(value, replacer);
}

/** Inverse of {@link encodeValue}. Walks the tree, reviving tagged nodes. */
export function decodeValue<T>(text: string): T {
  const parsed = JSON.parse(text);
  return walk(parsed) as T;
}

function walk(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(walk);
  if ((node as { $marmot?: string }).$marmot) return reviveTag(node as Tagged);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
  return out;
}

/**
 * A `GenericKeyValueStore<T>` scoped to one SQLite `marmot_kv` namespace, backed
 * by the encrypting {@link Store}. Values are codec-serialized here; the Store
 * NIP-44-encrypts the resulting string at rest.
 */
export function sqliteStore<T>(store: Store, namespace: string): GenericKeyValueStore<T> {
  return {
    async getItem(key: string): Promise<T | null> {
      const text = store.marmotKvGet(namespace, key);
      // marmot's contract is `T | null`; a missing item is null, never undefined.
      return text === undefined ? null : decodeValue<T>(text);
    },
    async setItem(key: string, value: T): Promise<T> {
      store.marmotKvSet(namespace, key, encodeValue(value));
      return value;
    },
    async removeItem(key: string): Promise<void> {
      store.marmotKvDelete(namespace, key);
    },
    async clear(): Promise<void> {
      store.marmotKvClear(namespace);
    },
    async keys(): Promise<string[]> {
      return store.marmotKvKeys(namespace);
    },
  };
}

/** The bundle of typed stores a coordinator `MarmotClient` is constructed with. */
export interface MarmotStores {
  groupStateStore: GenericKeyValueStore<SerializedClientState>;
  keyPackageStore: GenericKeyValueStore<StoredKeyPackage>;
  inviteStore: GenericKeyValueStore<StoredInviteEntry>;
  rewindStore: GenericKeyValueStore<Uint8Array>;
}

/** Build the four encrypted-at-rest marmot stores over the coordinator SQLite store. */
export function makeMarmotStores(store: Store): MarmotStores {
  return {
    groupStateStore: sqliteStore(store, MARMOT_NAMESPACES.groupState),
    keyPackageStore: sqliteStore(store, MARMOT_NAMESPACES.keyPackage),
    inviteStore: sqliteStore(store, MARMOT_NAMESPACES.invites),
    rewindStore: sqliteStore(store, MARMOT_NAMESPACES.rewind),
  };
}
