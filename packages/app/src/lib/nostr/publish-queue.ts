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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Backoff between publish attempts within a live session. NDK's "not enough
// relays received the event" is usually transient under concurrent publishes,
// so a couple of quick retries land the event without waiting for the next page
// load (spec §10.4 — the durable queue only flushes on boot/reconnect/interval).
const PUBLISH_BACKOFFS_MS = [500, 2000];

/**
 * Publish an event, falling back to the durable queue if it fails. Returns true
 * if it went out immediately, false if it was queued for later. When online,
 * retries up to 3 times with backoff (~500 ms, ~2 s) before persisting — a
 * transiently-failed publish otherwise sits invisible until the next flush.
 */
export async function publishOrQueue(
  event: VerifiedEvent,
  relays?: string[],
): Promise<boolean> {
  const online = typeof navigator === "undefined" || navigator.onLine;
  if (online) {
    // Offline skips retries entirely (below); online gets 1 + PUBLISH_BACKOFFS_MS.length tries.
    for (let attempt = 0; ; attempt++) {
      try {
        await publishSigned(event, relays);
        return true;
      } catch {
        if (attempt >= PUBLISH_BACKOFFS_MS.length) break; // exhausted — fall through to queue
        await sleep(PUBLISH_BACKOFFS_MS[attempt]);
      }
    }
  }
  // Callers routinely pass a relays array straight off Svelte $state (e.g.
  // ctx.config.relays) — that's a reactive Proxy, and IndexedDB's structured
  // clone algorithm cannot clone a Proxy ("DataCloneError: ... could not be
  // cloned"), which used to make this exact fallback throw and silently drop
  // the event instead of queuing it (caching verification 2026-07-17: a
  // transient "not enough relays received the event" under concurrent
  // publishes turned into permanent data loss here). Spread to a plain array
  // first so the durable queue actually survives a Proxy input.
  await persist({ event, relays: relays ? [...relays] : undefined, queuedAt: Date.now() });
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

/** How often the in-session flusher re-attempts a non-empty queue. */
const FLUSH_INTERVAL_MS = 60_000;

/** Wire automatic flushing on reconnect. Call once at app boot. */
export function installQueueFlusher(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("online", () => {
    void flushQueue();
  });
  // Besides "online", drain within a live session: publishOrQueue's retries
  // cover transient failures, but a publish that fails all attempts (or lands
  // offline) still needs a periodic sweep so it doesn't wait for the next boot.
  // A getAll a minute is cheap; only flush when there's actually something queued.
  setInterval(() => {
    void allQueued().then((items) => {
      if (items.length > 0) void flushQueue();
    });
  }, FLUSH_INTERVAL_MS);
}
