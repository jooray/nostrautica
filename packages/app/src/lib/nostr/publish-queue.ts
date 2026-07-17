/**
 * Publish queue with offline flush (spec §10.4). Outgoing signed events publish
 * immediately when online; on failure (or when offline) they persist to
 * IndexedDB and flush on reconnect. Goal: an attendee on terrible venue Wi-Fi
 * never loses a join request, follow, or profile update.
 */
import type { VerifiedEvent } from "nostr-tools/pure";
import { publishSigned } from "./ndk.js";

interface QueuedItem {
  event: VerifiedEvent;
  relays?: string[];
  queuedAt: number;
}

const DB_NAME = "nostrautica-outbox";
const STORE = "queue";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "event.id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function persist(item: QueuedItem): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function remove(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function allQueued(): Promise<QueuedItem[]> {
  const db = await openDb();
  const items = await new Promise<QueuedItem[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as QueuedItem[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return items;
}

/**
 * Publish an event, falling back to the durable queue if it fails. Returns true
 * if it went out immediately, false if it was queued for later.
 */
export async function publishOrQueue(
  event: VerifiedEvent,
  relays?: string[],
): Promise<boolean> {
  const online = typeof navigator === "undefined" || navigator.onLine;
  if (online) {
    try {
      await publishSigned(event, relays);
      return true;
    } catch {
      /* fall through to queue */
    }
  }
  await persist({ event, relays, queuedAt: Date.now() });
  return false;
}

/** Flush the queue: re-attempt every persisted event, removing successes. */
export async function flushQueue(): Promise<{ sent: number; remaining: number }> {
  const items = await allQueued();
  let sent = 0;
  for (const item of items) {
    try {
      await publishSigned(item.event, item.relays);
      await remove(item.event.id);
      sent++;
    } catch {
      /* leave it queued for the next flush */
    }
  }
  const remaining = (await allQueued()).length;
  return { sent, remaining };
}

/** Wire automatic flushing on reconnect. Call once at app boot. */
export function installQueueFlusher(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("online", () => {
    void flushQueue();
  });
}
