/**
 * Per-event key material persisted locally (IndexedDB) so decryption works
 * offline (spec §10.4) and the app doesn't re-derive keys on every navigation.
 *
 * What's stored, keyed by [owner pubkey, event coordinate] (audit G2/C1):
 *  - the ECK versions the user holds (granted via 21602, or minted as organizer)
 *  - the organizer's E_id / E_inbox secret keys (organizer only)
 *  - the user's role
 *
 * OWNER SCOPING: records are keyed by the logged-in identity ("owner") AND the
 * coordinate, so switching identity on one device never cross-contaminates two
 * users' custody. The active owner is set by the session on login/restore
 * (`setActiveOwner`) and every call resolves against it unless one is passed
 * explicitly (tests do). Legacy coordinate-only records (from before scoping)
 * are adopted into the current owner on first read so existing users aren't wiped.
 *
 * The canonical backup lives on relays (organizer: 30078 eventkeys, read back by
 * recover.ts; attendee/co-organizer: the 21602/21605 grants themselves). This
 * store is a fast local cache.
 */
import type { EckVersion } from "@nostrautica/protocol";

export interface EventKeys {
  coordinate: string;
  role: "organizer" | "attendee";
  eck: EckVersion[]; // {id, key(base64)}
  eidNsecHex?: string; // organizer only
  einboxNsecHex?: string; // organizer + coordinator only
}

/** On-disk shape: an EventKeys record scoped to the identity that owns it. */
interface StoredEventKeys extends EventKeys {
  owner: string; // owner (logged-in identity) pubkey
}

/**
 * Storage backend seam. Production uses IndexedDB; tests inject an in-memory
 * implementation (the test environment has no IndexedDB). Migration/adoption
 * logic lives in the module functions, so it is exercised by the in-memory tests.
 */
export interface KeystoreBackend {
  get(owner: string, coordinate: string): Promise<StoredEventKeys | undefined>;
  put(rec: StoredEventKeys): Promise<void>;
  list(owner: string): Promise<StoredEventKeys[]>;
  // Legacy (coordinate-only) records, kept for one-time migration.
  legacyGet(coordinate: string): Promise<EventKeys | undefined>;
  legacyList(): Promise<EventKeys[]>;
  legacyDelete(coordinate: string): Promise<void>;
}

// ── Active owner ─────────────────────────────────────────────────────────────

let activeOwner: string | null = null;

/** Called by the session on login/restore/logout so reads scope to that identity. */
export function setActiveOwner(pubkey: string | null): void {
  activeOwner = pubkey;
}

function ownerForRead(explicit?: string): string | null {
  return explicit ?? activeOwner;
}
function ownerForWrite(explicit?: string): string {
  const o = explicit ?? activeOwner;
  if (!o) throw new Error("keystore write with no active identity");
  return o;
}

function toPublic(r: StoredEventKeys): EventKeys {
  return {
    coordinate: r.coordinate,
    role: r.role,
    eck: r.eck,
    eidNsecHex: r.eidNsecHex,
    einboxNsecHex: r.einboxNsecHex,
  };
}

// ── IndexedDB backend ────────────────────────────────────────────────────────

const DB_NAME = "nostrautica-eventkeys";
const DB_VERSION = 2;
const LEGACY_STORE = "keys"; // v1 store: keyPath "coordinate"
const STORE = "keys2"; // v2 store: keyPath ["owner","coordinate"], index "by-owner"

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Keep the v1 store around so legacy records survive to be migrated.
      if (!db.objectStoreNames.contains(LEGACY_STORE)) {
        db.createObjectStore(LEGACY_STORE, { keyPath: "coordinate" });
      }
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: ["owner", "coordinate"] });
        os.createIndex("by-owner", "owner", { unique: false });
      }
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

const indexedDbBackend: KeystoreBackend = {
  async get(owner, coordinate) {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readonly");
      return (await reqAsync(tx.objectStore(STORE).get([owner, coordinate]))) as
        | StoredEventKeys
        | undefined;
    } finally {
      db.close();
    }
  },
  async put(rec) {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(rec);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
  async list(owner) {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readonly");
      const idx = tx.objectStore(STORE).index("by-owner");
      return (await reqAsync(idx.getAll(owner))) as StoredEventKeys[];
    } finally {
      db.close();
    }
  },
  async legacyGet(coordinate) {
    const db = await openDb();
    try {
      const tx = db.transaction(LEGACY_STORE, "readonly");
      return (await reqAsync(tx.objectStore(LEGACY_STORE).get(coordinate))) as
        | EventKeys
        | undefined;
    } finally {
      db.close();
    }
  },
  async legacyList() {
    const db = await openDb();
    try {
      const tx = db.transaction(LEGACY_STORE, "readonly");
      return (await reqAsync(tx.objectStore(LEGACY_STORE).getAll())) as EventKeys[];
    } finally {
      db.close();
    }
  },
  async legacyDelete(coordinate) {
    const db = await openDb();
    try {
      const tx = db.transaction(LEGACY_STORE, "readwrite");
      tx.objectStore(LEGACY_STORE).delete(coordinate);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
};

let backend: KeystoreBackend = indexedDbBackend;

/** Swap the storage backend (tests only). Pass null to restore IndexedDB. */
export function __setKeystoreBackend(b: KeystoreBackend | null): void {
  backend = b ?? indexedDbBackend;
}

// ── Public API (coordinate-only signatures preserved; owner is implicit) ──────

export async function saveEventKeys(keys: EventKeys, owner?: string): Promise<void> {
  const o = ownerForWrite(owner);
  await backend.put({ ...keys, owner: o });
}

/**
 * All events the current identity holds keys for (created or was approved into).
 * Adopts any leftover legacy coordinate-only records into this owner first.
 */
export async function listEventKeys(owner?: string): Promise<EventKeys[]> {
  const o = ownerForRead(owner);
  if (!o) return [];
  const records = await backend.list(o);
  const have = new Set(records.map((r) => r.coordinate));
  const legacy = await backend.legacyList();
  for (const l of legacy) {
    // A legacy record for a coordinate this owner already has is stale — drop it.
    if (have.has(l.coordinate)) {
      await backend.legacyDelete(l.coordinate);
      continue;
    }
    const adopted: StoredEventKeys = { ...l, owner: o };
    await backend.put(adopted);
    await backend.legacyDelete(l.coordinate);
    records.push(adopted);
    have.add(l.coordinate);
  }
  return records.map(toPublic);
}

export async function loadEventKeys(
  coordinate: string,
  owner?: string,
): Promise<EventKeys | undefined> {
  const o = ownerForRead(owner);
  if (!o) return undefined;
  const rec = await backend.get(o, coordinate);
  if (rec) return toPublic(rec);
  // Graceful migration: adopt a legacy coordinate-only record into this owner.
  const legacy = await backend.legacyGet(coordinate);
  if (legacy) {
    const adopted: StoredEventKeys = { ...legacy, owner: o };
    await backend.put(adopted);
    await backend.legacyDelete(coordinate);
    return toPublic(adopted);
  }
  return undefined;
}

/** Merge new ECK versions into a stored record (dedupe by id), keeping the max. */
export async function addEckVersions(
  coordinate: string,
  versions: EckVersion[],
  role: "organizer" | "attendee" = "attendee",
  owner?: string,
): Promise<EventKeys> {
  const o = ownerForWrite(owner);
  const existing = (await loadEventKeys(coordinate, o)) ?? {
    coordinate,
    role,
    eck: [],
  };
  const byId = new Map<number, EckVersion>();
  for (const v of existing.eck) byId.set(v.id, v);
  for (const v of versions) byId.set(v.id, v);
  existing.eck = [...byId.values()].sort((a, b) => a.id - b.id);
  await saveEventKeys(existing, o);
  return existing;
}

/** The highest-numbered ECK version the user holds, or undefined. */
export function currentEck(keys: EventKeys | undefined): EckVersion | undefined {
  if (!keys || keys.eck.length === 0) return undefined;
  return keys.eck.reduce((max, v) => (v.id > max.id ? v : max));
}
