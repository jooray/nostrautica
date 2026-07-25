/**
 * Publish queue with offline flush (spec §10.4). Outgoing signed events publish
 * immediately when online; on failure (or when offline) they persist to
 * IndexedDB and flush on reconnect. Goal: an attendee on terrible venue Wi-Fi
 * never loses a join request, follow, or profile update.
 *
 * App-8 hardening:
 *  - SINGLE FLUSHER across tabs: the durable flush runs under a Web Lock, so two
 *    open tabs don't both re-publish the same queued events (double sends, wasted
 *    relay round-trips, and racing deletes). Without Web Locks it degrades to
 *    best-effort per-tab flushing.
 *  - EXPLICIT ORDERING: the flush processes items in `queuedAt` order rather than
 *    IndexedDB key order, so events go out roughly in the order they were made.
 *  - PERMANENT-FAILURE POLICY: each durable flush attempt bumps a counter; after
 *    `MAX_FLUSH_ATTEMPTS` an item is parked in a terminal `failed` state instead
 *    of being retried forever, and surfaced in the outbox UI for the user to
 *    retry or discard.
 *
 * Storage is behind an injectable backend seam (mirroring keystore/persist) so
 * the queue logic is unit-testable without IndexedDB; production uses IndexedDB.
 */
import type { VerifiedEvent } from "nostr-tools/pure";
import { publishSigned } from "./ndk.js";
import { activeCacheOwner } from "$lib/cache/persist.js";

export interface QueuedItem {
  event: VerifiedEvent;
  relays?: string[];
  queuedAt: number;
  /** Durable flush attempts so far (not the in-session publishOrQueue retries). */
  attempts: number;
  /** Terminal: exhausted `MAX_FLUSH_ATTEMPTS`, awaiting user retry/discard. */
  failed?: boolean;
  /** Message from the most recent failed flush (audit §7.4.7 Sync Status). */
  lastError?: string;
  /**
   * Immutable pubkey of the account that queued this item (audit U1). Set once at
   * enqueue time from the active cache owner and NEVER rewritten. The flusher and
   * the outbox UI only ever touch items whose `owner` matches the CURRENTLY active
   * account, so on a shared device account B never sees, flushes, or publishes
   * account A's already-signed actions. `undefined` marks a legacy pre-U1 item
   * (no attribution) — those are dropped on the next flush rather than risk
   * publishing them under the wrong identity.
   */
  owner?: string;
}

/** After this many failed durable flushes an item is parked as `failed`. */
export const MAX_FLUSH_ATTEMPTS = 5;

/**
 * Per-event publication outcome (audit U2). `publishOrQueue` returns a bare
 * boolean; submitters that fan out into several events surface these so the UI
 * can distinguish "went to a relay" from "only saved locally, will send later"
 * instead of collapsing everything to a false "done". Venue Wi-Fi routinely
 * allows HTTPS (Blossom uploads) while blocking WSS (relay publishes), so an
 * upload succeeding is never evidence the relay event went out.
 */
export type PublishOutcome = "published" | "queued";

/** Map `publishOrQueue`'s boolean to the richer outcome (U2). */
export function toOutcome(published: boolean): PublishOutcome {
  return published ? "published" : "queued";
}

const DB_NAME = "nostrautica-outbox";
const STORE = "queue";

// ── Storage backend seam (production = IndexedDB; tests inject in-memory) ─────

export interface OutboxBackend {
  getAll(): Promise<QueuedItem[]>;
  put(item: QueuedItem): Promise<void>;
  delete(id: string): Promise<void>;
}

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

const indexedDbBackend: OutboxBackend = {
  async getAll() {
    const db = await openDb();
    const items = await new Promise<QueuedItem[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as QueuedItem[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return items;
  },
  async put(item) {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  },
  async delete(id) {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  },
};

let backend: OutboxBackend | null =
  typeof indexedDB !== "undefined" ? indexedDbBackend : null;

/** Swap the storage backend (tests only). Pass null to restore IndexedDB. */
export function __setOutboxBackend(b: OutboxBackend | null): void {
  backend = b ?? (typeof indexedDB !== "undefined" ? indexedDbBackend : null);
}

// ── Single-flusher lock seam (Web Locks; tests inject) ───────────────────────

export interface OutboxLockManager {
  request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown | null) => Promise<unknown>,
  ): Promise<unknown>;
}

let locks: OutboxLockManager | null | undefined; // undefined = use default

function defaultLocks(): OutboxLockManager | null {
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    return (navigator as unknown as { locks: OutboxLockManager }).locks;
  }
  return null;
}

/** Inject (or, with null, disable) the Web Locks manager (tests only). */
export function __setOutboxLocks(l: OutboxLockManager | null | undefined): void {
  locks = l;
}

/**
 * Run `fn` holding the exclusive outbox-flush lock. If another tab holds it,
 * `fn` is skipped (returns undefined) — that tab is already flushing. Without a
 * Web Locks manager, `fn` runs unguarded (best-effort single-tab behaviour).
 */
async function withFlushLock<T>(fn: () => Promise<T>): Promise<T | undefined> {
  const mgr = locks === undefined ? defaultLocks() : locks;
  if (!mgr) return fn();
  return (await mgr.request("nostrautica-outbox-flush", { ifAvailable: true }, async (lock) =>
    lock === null ? undefined : fn(),
  )) as T | undefined;
}

// ── Queue operations ─────────────────────────────────────────────────────────

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
  await backend?.put({
    event,
    relays: relays ? [...relays] : undefined,
    queuedAt: Date.now(),
    attempts: 0,
    // U1: stamp the queuing account. Falls back to the event author when logged
    // out (no active cache owner) so an item is never silently ownerless — the
    // author signed it, so it belongs to that key.
    owner: activeCacheOwner() ?? event.pubkey,
  });
  return false;
}

/**
 * Whether `item` belongs to the account `active` (U1). A legacy item with no
 * `owner` belongs to no one — never flushed or shown, dropped on next flush.
 */
function ownedBy(item: QueuedItem, active: string | null): boolean {
  return item.owner !== undefined && item.owner === active;
}

export interface FlushResult {
  sent: number;
  remaining: number;
  failed: number;
  /** True when another tab held the flush lock and this call did nothing. */
  skipped?: boolean;
}

/**
 * Flush the queue under the single-flusher lock: re-attempt every non-terminal
 * persisted event in `queuedAt` order, removing successes and parking an item as
 * `failed` once it exhausts `MAX_FLUSH_ATTEMPTS`.
 */
export async function flushQueue(): Promise<FlushResult> {
  const res = await withFlushLock(flushQueueCore);
  return res ?? { sent: 0, remaining: 0, failed: 0, skipped: true };
}

async function flushQueueCore(): Promise<FlushResult> {
  if (!backend) return { sent: 0, remaining: 0, failed: 0 };
  const active = activeCacheOwner();
  const items = (await backend.getAll()).sort((a, b) => a.queuedAt - b.queuedAt);
  let sent = 0;
  for (const item of items) {
    // U1 migration: a legacy ownerless item (queued before U1) has no attribution,
    // so we cannot know which account signed it. Dropping is the safe choice — the
    // alternative (publishing it under whoever is active now) is exactly the
    // cross-account leak this finding closes. Rare: only offline items straddling
    // the upgrade.
    if (item.owner === undefined) {
      await backend.delete(item.event.id).catch(() => {});
      continue;
    }
    // Only ever publish the ACTIVE account's items. Another account's queued items
    // stay untouched and invisible until that identity is active again (U1).
    if (!ownedBy(item, active)) continue;
    if (item.failed) continue; // terminal — never auto-retried
    try {
      await publishSigned(item.event, item.relays);
      await backend.delete(item.event.id);
      sent++;
    } catch (e) {
      const attempts = (item.attempts ?? 0) + 1;
      const failed = attempts >= MAX_FLUSH_ATTEMPTS;
      const lastError = e instanceof Error ? e.message : String(e);
      await backend.put({ ...item, attempts, failed, lastError }).catch(() => {});
    }
  }
  const after = (await backend.getAll()).filter((i) => ownedBy(i, active));
  return {
    sent,
    remaining: after.filter((i) => !i.failed).length,
    failed: after.filter((i) => i.failed).length,
  };
}

/**
 * The ACTIVE account's queued items (for the outbox UI observer), newest-queued
 * last. Another account's items and legacy ownerless items are never returned, so
 * the Sync Status UI can never display or act on an item that isn't the current
 * user's (U1). Empty when unavailable.
 */
export async function listQueued(): Promise<QueuedItem[]> {
  if (!backend) return [];
  const active = activeCacheOwner();
  return (await backend.getAll())
    .filter((i) => ownedBy(i, active))
    .sort((a, b) => a.queuedAt - b.queuedAt);
}

/** How many items (pending + failed) the given account has queued (U1). */
export async function countQueuedForOwner(owner: string): Promise<number> {
  if (!backend) return 0;
  return (await backend.getAll()).filter((i) => i.owner === owner).length;
}

/**
 * Permanently drop every item queued by `owner` (U1). Called from `logout()`:
 * per the maintainer decision, a logout DISCARDS that account's still-unsent
 * actions (the UI warns first when any exist) rather than leaving already-signed
 * events to publish silently in a later session. Returns how many were removed.
 */
export async function discardQueuedForOwner(owner: string): Promise<number> {
  if (!backend) return 0;
  const mine = (await backend.getAll()).filter((i) => i.owner === owner);
  for (const item of mine) await backend.delete(item.event.id).catch(() => {});
  return mine.length;
}

/**
 * User action from the outbox UI: revive a parked `failed` item (reset its
 * terminal state + attempt counter) and flush. Returns the flush result.
 */
export async function retryFailed(id: string): Promise<FlushResult> {
  if (backend) {
    const item = (await backend.getAll()).find((i) => i.event.id === id);
    if (item?.failed) await backend.put({ ...item, failed: false, attempts: 0 });
  }
  return flushQueue();
}

/** User action from the outbox UI: permanently drop a queued/failed item. */
export async function discardQueued(id: string): Promise<void> {
  await backend?.delete(id);
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
  // A getAll a minute is cheap; only flush when there's something still pending
  // (a terminal-failed item is not retried, so it doesn't keep the sweep busy).
  setInterval(() => {
    const active = activeCacheOwner();
    void backend
      ?.getAll()
      .then((items) => {
        // Only sweep when the ACTIVE account has something non-terminal pending —
        // another account's queued items must not keep the flusher busy (U1).
        if (items.some((i) => !i.failed && ownedBy(i, active))) void flushQueue();
      })
      .catch(() => {});
  }, FLUSH_INTERVAL_MS);
}
