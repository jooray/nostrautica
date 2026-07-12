/**
 * Per-event key material persisted locally (IndexedDB) so decryption works
 * offline (spec §10.4) and the app doesn't re-derive keys on every navigation.
 *
 * What's stored, keyed by event coordinate:
 *  - the ECK versions the user holds (granted via 21602, or minted as organizer)
 *  - the organizer's E_id / E_inbox secret keys (organizer only)
 *  - the user's role
 *
 * The canonical backup lives on relays (organizer: 30078 eventkeys; attendee:
 * the 21602 grants themselves). This store is a fast local cache.
 */
import type { EckVersion } from "@nostrautica/protocol";

export interface EventKeys {
  coordinate: string;
  role: "organizer" | "attendee";
  eck: EckVersion[]; // {id, key(base64)}
  eidNsecHex?: string; // organizer only
  einboxNsecHex?: string; // organizer + coordinator only
}

const DB_NAME = "nostrautica-eventkeys";
const STORE = "keys";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "coordinate" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveEventKeys(keys: EventKeys): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(keys);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadEventKeys(coordinate: string): Promise<EventKeys | undefined> {
  const db = await openDb();
  const keys = await new Promise<EventKeys | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(coordinate);
    req.onsuccess = () => resolve(req.result as EventKeys | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return keys;
}

/** Merge new ECK versions into a stored record (dedupe by id), keeping the max. */
export async function addEckVersions(
  coordinate: string,
  versions: EckVersion[],
  role: "organizer" | "attendee" = "attendee",
): Promise<EventKeys> {
  const existing = (await loadEventKeys(coordinate)) ?? {
    coordinate,
    role,
    eck: [],
  };
  const byId = new Map<number, EckVersion>();
  for (const v of existing.eck) byId.set(v.id, v);
  for (const v of versions) byId.set(v.id, v);
  existing.eck = [...byId.values()].sort((a, b) => a.id - b.id);
  await saveEventKeys(existing);
  return existing;
}

/** The highest-numbered ECK version the user holds, or undefined. */
export function currentEck(keys: EventKeys | undefined): EckVersion | undefined {
  if (!keys || keys.eck.length === 0) return undefined;
  return keys.eck.reduce((max, v) => (v.id > max.id ? v : max));
}
