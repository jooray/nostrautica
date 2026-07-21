/**
 * Queued-publish visibility (audit UX-15). `publishOrQueue` (nostr/publish-queue.ts)
 * returns false when an event lands in the durable outbox instead of going out,
 * but nothing surfaced that anywhere — a join request, follow, or DM sent on
 * flaky venue Wi-Fi looked lost. This store keeps a reactive count of what is
 * sitting in the outbox so the shell can show a quiet "will sync" chip, and call
 * sites can warn inline at send time.
 *
 * It reads the SAME IndexedDB the queue persists to (read-only, own connection)
 * — publish-queue.ts owns all writes; this is a passive observer. `noteQueued()`
 * lets a call site that just queued something update the count immediately
 * instead of waiting for the next poll.
 */

// Mirrors the constants in nostr/publish-queue.ts (its file — do not import
// internals; the DB contract is the seam).
const DB_NAME = "nostrautica-outbox";
const STORE = "queue";
const POLL_MS = 30_000;

/** Count queued items; 0 when the DB/store doesn't exist or can't be read. */
async function countQueued(): Promise<number> {
  if (typeof indexedDB === "undefined") return 0;
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME);
    } catch {
      resolve(null);
      return;
    }
    // A missing DB means an empty queue — but opening a missing DB would CREATE
    // it (version 1, without the object store), and publish-queue's own
    // open-with-upgrade would then never fire its onupgradeneeded, breaking the
    // queue itself. Abort the upgrade: the just-created empty DB is rolled back
    // and the open fails, which we treat as "empty".
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  if (!db) return 0;
  try {
    if (!db.objectStoreNames.contains(STORE)) return 0;
    return await new Promise<number>((resolve) => {
      try {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(0);
      } catch {
        resolve(0);
      }
    });
  } finally {
    db.close();
  }
}

class Outbox {
  /** Events sitting in the durable publish queue right now. */
  pending = $state(0);
  private started = false;
  private recountTimer: ReturnType<typeof setTimeout> | undefined;

  /** Begin observing the outbox (idempotent; safe to call from any component). */
  init(): void {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    void this.refresh();
    // The queue flushes on reconnect — recount shortly after "online" so the
    // chip clears once the flush drained (and stays if it didn't).
    window.addEventListener("online", () => this.refreshSoon(2_000));
    setInterval(() => void this.refresh(), POLL_MS);
  }

  /** Recount now (best-effort, never throws). */
  async refresh(): Promise<void> {
    this.pending = await countQueued();
  }

  /** Recount shortly — coalesces bursts (e.g. several queued sends at once). */
  refreshSoon(delayMs = 750): void {
    if (this.recountTimer) return;
    this.recountTimer = setTimeout(() => {
      this.recountTimer = undefined;
      void this.refresh();
    }, delayMs);
  }

  /** A call site just queued something — reflect it without waiting for the poll. */
  noteQueued(): void {
    this.init();
    this.refreshSoon();
  }
}

export const outbox = new Outbox();
