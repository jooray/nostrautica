/**
 * Local-key persistence in IndexedDB (spec §14: local keys in IndexedDB, not
 * localStorage strings). Stores the raw 32-byte secret key plus the chosen login
 * method so a returning local-key user is logged straight back in.
 *
 * A tiny hand-rolled IndexedDB wrapper avoids pulling a dependency for one store.
 */
const DB_NAME = "nostrautica";
const STORE = "keystore";
const SK_KEY = "local-sk";
const METHOD_KEY = "login-method";
const NIP46_KEY = "nip46-session";

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

async function put(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function get<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  const value = await new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

async function del(key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function saveLocalKey(sk: Uint8Array): Promise<void> {
  // Store a copy as a plain array-backed Uint8Array (structured-clone safe).
  await put(SK_KEY, new Uint8Array(sk));
  await put(METHOD_KEY, "local");
}

export async function loadLocalKey(): Promise<Uint8Array | undefined> {
  const stored = await get<Uint8Array>(SK_KEY);
  return stored ? new Uint8Array(stored) : undefined;
}

export async function saveLoginMethod(method: string): Promise<void> {
  await put(METHOD_KEY, method);
}

export async function loadLoginMethod(): Promise<string | undefined> {
  return get<string>(METHOD_KEY);
}

/**
 * Persist a NIP-46 (Amber) session so it survives a refresh (spec §5.3).
 *
 * SECURITY (audit U17): the stored session is a BEARER CAPABILITY for the remote
 * signer connection (client key + bunker secret), NOT the account private key,
 * and IndexedDB is not treated as secret storage against same-origin compromise.
 * See the `Nip46Session` doc in signer/nip46.ts for the full rationale. It is
 * cleared predictably by `clearKeystore()` (called on every logout path) and on
 * a detected bunker identity swap.
 */
export async function saveNip46Session(session: unknown): Promise<void> {
  await put(NIP46_KEY, session);
  await put(METHOD_KEY, "nip46");
}

export async function loadNip46Session<T>(): Promise<T | undefined> {
  return get<T>(NIP46_KEY);
}

/**
 * Wipe all persisted login material: the local secret key, the login method, and
 * the NIP-46 bearer capability (audit U17 — predictable clearing). Called on
 * every logout path (session.logout) and on a NIP-46 identity mismatch.
 */
export async function clearKeystore(): Promise<void> {
  await del(SK_KEY);
  await del(METHOD_KEY);
  await del(NIP46_KEY);
}
