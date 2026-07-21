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
 * are NEVER auto-adopted (audit APPK-6, see loadEventKeys) — the relay-backup
 * recovery flow (recover.ts) restores them owner-scoped instead.
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
 * A record's plaintext, self-encrypted (NIP-44 to the owner's own pubkey) for
 * on-device storage across logout (audit UX-6). See `lockEventKeysForLogout`.
 */
export interface LockedEventKeys {
  owner: string;
  coordinate: string;
  ciphertext: string;
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
  delete(owner: string, coordinate: string): Promise<void>;
  // Legacy (coordinate-only) records, kept for one-time migration.
  legacyGet(coordinate: string): Promise<EventKeys | undefined>;
  legacyList(): Promise<EventKeys[]>;
  legacyDelete(coordinate: string): Promise<void>;
  // Self-encrypted snapshots that survive logout (audit UX-6).
  lockedPut(rec: LockedEventKeys): Promise<void>;
  lockedList(owner: string): Promise<LockedEventKeys[]>;
  lockedDelete(owner: string, coordinate: string): Promise<void>;
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
const DB_VERSION = 3;
const LEGACY_STORE = "keys"; // v1 store: keyPath "coordinate"
const STORE = "keys2"; // v2 store: keyPath ["owner","coordinate"], index "by-owner"
const LOCKED_STORE = "keys2-locked"; // v3 store: self-encrypted snapshots (audit UX-6)

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
      if (!db.objectStoreNames.contains(LOCKED_STORE)) {
        const os = db.createObjectStore(LOCKED_STORE, { keyPath: ["owner", "coordinate"] });
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
  async delete(owner, coordinate) {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete([owner, coordinate]);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
  async lockedPut(rec) {
    const db = await openDb();
    try {
      const tx = db.transaction(LOCKED_STORE, "readwrite");
      tx.objectStore(LOCKED_STORE).put(rec);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
  async lockedList(owner) {
    const db = await openDb();
    try {
      const tx = db.transaction(LOCKED_STORE, "readonly");
      const idx = tx.objectStore(LOCKED_STORE).index("by-owner");
      return (await reqAsync(idx.getAll(owner))) as LockedEventKeys[];
    } finally {
      db.close();
    }
  },
  async lockedDelete(owner, coordinate) {
    const db = await openDb();
    try {
      const tx = db.transaction(LOCKED_STORE, "readwrite");
      tx.objectStore(LOCKED_STORE).delete([owner, coordinate]);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
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

// One console warning per coordinate per session is enough (APPK-6).
const warnedLegacy = new Set<string>();
function warnLegacy(coordinate: string): void {
  if (warnedLegacy.has(coordinate)) return;
  warnedLegacy.add(coordinate);
  console.warn(
    "[keystore] found a legacy (pre-owner-scoping) key record for",
    coordinate,
    "— it is NOT auto-adopted (audit APPK-6: whichever identity read first used" +
      " to inherit its custody, so a different person logging in on a shared" +
      " device would gain the previous owner's organizer keys). Recover the" +
      " event keys from the relay backup instead (the recover.ts flow restores" +
      " them owner-scoped).",
  );
}

/**
 * All events the current identity holds keys for (created or was approved into).
 * Legacy coordinate-only records are reported but left untouched (APPK-6).
 */
export async function listEventKeys(owner?: string): Promise<EventKeys[]> {
  const o = ownerForRead(owner);
  if (!o) return [];
  const records = await backend.list(o);
  for (const l of await backend.legacyList()) warnLegacy(l.coordinate);
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
  // APPK-6: do NOT adopt a legacy coordinate-only record into this owner. The
  // record carries no ownership proof, so adoption hands its custody to
  // whichever identity happens to read first — on a shared device, the wrong
  // person. The legit same-owner case is served by the relay-backup recovery
  // (recover.ts re-encrypts custody proofs owner-scoped), so nothing is lost by
  // leaving these records in place.
  if (await backend.legacyGet(coordinate)) warnLegacy(coordinate);
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

/**
 * Fold an authenticated 21605 organizer grant into the stored record (audit
 * APPK-4): UNION the ECK versions by id — never shrink the set — so an
 * authentic-but-stale grant (ECK v1) processed after a fresher 21602 (v2) can't
 * clobber the record back to v1-only (wraps are memoized, so the loss used to
 * be permanent). Role + custody secrets update from the grant.
 */
export async function applyOrganizerGrant(
  coordinate: string,
  grant: { eck: EckVersion[]; eidNsecHex: string; einboxNsecHex: string },
  owner?: string,
): Promise<EventKeys> {
  const o = ownerForWrite(owner);
  const existing = (await loadEventKeys(coordinate, o)) ?? {
    coordinate,
    role: "organizer" as const,
    eck: [],
  };
  const byId = new Map<number, EckVersion>();
  for (const v of existing.eck) byId.set(v.id, v);
  for (const v of grant.eck) byId.set(v.id, v);
  existing.eck = [...byId.values()].sort((a, b) => a.id - b.id);
  existing.role = "organizer";
  existing.eidNsecHex = grant.eidNsecHex;
  existing.einboxNsecHex = grant.einboxNsecHex;
  await saveEventKeys(existing, o);
  return existing;
}

/**
 * Self-encrypt every live record for the active owner and drop the plaintext
 * (audit UX-6). Organizer nsecs (E_id/E_inbox) and ECKs must never be LOST on
 * logout — that was the original reason they were left in plaintext — but they
 * also must not sit in cleartext IndexedDB for the next person on a shared
 * device to read. `encrypt` is the caller's self-encrypt (NIP-44 to the owner's
 * own pubkey), so only a signer that can authenticate as this owner can ever
 * decrypt the backup again.
 *
 * Best-effort per record: if encryption fails (e.g. a NIP-46 signer that's
 * unreachable right at logout), that record's plaintext is left in place rather
 * than risked — losing key custody is worse than a missed hygiene pass, and the
 * next successful logout will lock it.
 */
export async function lockEventKeysForLogout(
  encrypt: (plaintext: string) => Promise<string>,
  owner?: string,
): Promise<void> {
  const o = ownerForRead(owner);
  if (!o) return;
  for (const rec of await backend.list(o)) {
    try {
      const ciphertext = await encrypt(JSON.stringify(toPublic(rec)));
      await backend.lockedPut({ owner: o, coordinate: rec.coordinate, ciphertext });
      await backend.delete(o, rec.coordinate);
    } catch {
      /* left in plaintext; retried on the next logout */
    }
  }
}

/**
 * Reverse of {@link lockEventKeysForLogout}: decrypt every locked snapshot for
 * this owner back into the live store (audit UX-6). Call on login/restore,
 * before anything reads event-key custody, so a returning user's organizer
 * authority and ECKs are available immediately without a relay round-trip
 * (unlike the `recover.ts` relay-backup path, this is local and instant).
 *
 * Merges with any live record by unioning ECK versions (never shrinking, same
 * rule as `applyOrganizerGrant`/APPK-4) rather than overwriting, in case some
 * activity already wrote a fresher live record before the unlock ran. On
 * success the locked snapshot is deleted — the live record is the source of
 * truth again until the next logout re-locks it. Undecryptable snapshots (wrong
 * signer, or none available yet) are left in place and retried later.
 */
export async function unlockEventKeysForLogin(
  decrypt: (ciphertext: string) => Promise<string>,
  owner?: string,
): Promise<void> {
  const o = ownerForRead(owner);
  if (!o) return;
  for (const locked of await backend.lockedList(o)) {
    try {
      const restored = JSON.parse(await decrypt(locked.ciphertext)) as EventKeys;
      const existing = await backend.get(o, locked.coordinate);
      const byId = new Map<number, EckVersion>();
      for (const v of restored.eck) byId.set(v.id, v);
      for (const v of existing?.eck ?? []) byId.set(v.id, v);
      await backend.put({
        coordinate: locked.coordinate,
        // Never downgrade: organizer authority wins if either side has it.
        role: existing?.role === "organizer" || restored.role === "organizer" ? "organizer" : restored.role,
        eck: [...byId.values()].sort((a, b) => a.id - b.id),
        eidNsecHex: existing?.eidNsecHex ?? restored.eidNsecHex,
        einboxNsecHex: existing?.einboxNsecHex ?? restored.einboxNsecHex,
        owner: o,
      });
      await backend.lockedDelete(o, locked.coordinate);
    } catch {
      /* undecryptable (or the signer isn't ready yet) — retried next login */
    }
  }
}

/** The highest-numbered ECK version the user holds, or undefined. */
export function currentEck(keys: EventKeys | undefined): EckVersion | undefined {
  if (!keys || keys.eck.length === 0) return undefined;
  return keys.eck.reduce((max, v) => (v.id > max.id ? v : max));
}
