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
 *    retry or discard. Those attempts are rationed by TIME, not by flush calls
 *    (FLUSH_BACKOFF_MS) — the flush fires on every `online` event, and venue
 *    captive portals flap several times a minute.
 *  - PER-RELAY CONVERGENCE: a publish succeeds at the first relay that acks, so
 *    both the live path (`queueUndelivered`) and the durable redelivery
 *    (`flushQueueCore`) read `publishSigned`'s per-relay outcomes and keep
 *    carrying the event to whichever relays still don't have it.
 *
 * Storage is behind an injectable backend seam (mirroring keystore/persist) so
 * the queue logic is unit-testable without IndexedDB; production uses IndexedDB.
 */
import type { VerifiedEvent } from "nostr-tools/pure";
import { publishSigned, type RelayPublishOutcome } from "./ndk.js";
import { isRetryableRelayFailure } from "./errors.js";
import { activeCacheOwner } from "$lib/cache/persist.js";

export interface QueuedItem {
  event: VerifiedEvent;
  relays?: string[];
  queuedAt: number;
  /** Durable flush attempts so far (not the in-session publishOrQueue retries). */
  attempts: number;
  /**
   * When the most recent durable flush attempt ran. Drives the per-item backoff
   * (see FLUSH_BACKOFF_MS) so `attempts` is spent on elapsed time rather than on
   * how many times the browser happened to fire `online`. Absent on items
   * written by a pre-backoff build.
   */
  lastAttemptAt?: number;
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
  /**
   * This event IS published — it reached at least one relay — and this item
   * exists only to carry it to relays that missed it (`relays` holds exactly
   * those). Convergence work, not a pending user action, so it stays out of the
   * outbox UI, out of the logout warning, and is dropped rather than parked when
   * it runs out of attempts: there is nothing for the user to decide about a
   * straggler relay, and nagging them about one would be noise about an action
   * that already succeeded.
   */
  partial?: true;
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
  /**
   * Read ONE row by event id. Optional so the in-memory test backends need not
   * implement it (`getOne` below falls back to a scan) — production implements
   * it because the alternative is a full-store `getAll()` + deserialize on every
   * successful publish just to answer "is this event already queued?".
   */
  get?(id: string): Promise<QueuedItem | undefined>;
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

/**
 * ONE long-lived connection instead of open/close around every operation.
 *
 * Every method here used to `indexedDB.open()` and `db.close()` on its own, so a
 * flush of N items cost 2N+2 open/close cycles (getAll, then a put-or-delete per
 * item, then the closing getAll). On a low-end phone during an "approve all"
 * burst — the organizer taps twenty approvals, each fanning out into several
 * signed events — that is hundreds of connection handshakes competing with the
 * signer round trips for the same main thread.
 *
 * A cached handle is safe as long as it is DROPPED when the browser takes it
 * away: `onclose` fires when the connection is force-closed (storage cleared,
 * tab discarded and restored) and `onversionchange` when another tab wants to
 * upgrade the schema — in both cases the next call must open a fresh one rather
 * than issue transactions against a dead handle.
 */
let dbHandle: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (dbHandle) return dbHandle;
  const opening = openDb().then((conn) => {
    const forget = () => {
      if (dbHandle === opening) dbHandle = null;
    };
    conn.onclose = forget;
    conn.onversionchange = () => {
      conn.close();
      forget();
    };
    return conn;
  });
  dbHandle = opening;
  // A failed open must not be cached, or the outbox is dead for the page's life.
  opening.catch(() => {
    if (dbHandle === opening) dbHandle = null;
  });
  return opening;
}

/** Resolve when the transaction commits; reject on its error/abort. */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const indexedDbBackend: OutboxBackend = {
  async getAll() {
    const conn = await db();
    return new Promise<QueuedItem[]>((resolve, reject) => {
      const tx = conn.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as QueuedItem[]);
      req.onerror = () => reject(req.error);
    });
  },
  // Point read instead of a full-store scan + deserialize. `queueUndelivered`
  // runs on EVERY successful publish and only ever wants one row.
  async get(id) {
    const conn = await db();
    return new Promise<QueuedItem | undefined>((resolve, reject) => {
      const tx = conn.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result as QueuedItem | undefined);
      req.onerror = () => reject(req.error);
    });
  },
  async put(item) {
    const conn = await db();
    const tx = conn.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    await txDone(tx);
  },
  async delete(id) {
    const conn = await db();
    const tx = conn.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    await txDone(tx);
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

/** One row by event id, using the backend's point read when it has one. */
async function getOne(id: string): Promise<QueuedItem | undefined> {
  if (!backend) return undefined;
  if (backend.get) return backend.get(id);
  return (await backend.getAll()).find((i) => i.event.id === id);
}

/**
 * The relays from a fan-out that still don't have the event AND could still take
 * it. `publishSigned` resolves as soon as ONE relay acks, so its per-relay
 * outcomes are the only place the other relays' answers exist — a caller that
 * ignores them cannot tell "all four took it" from "one took it, three timed
 * out". A refusal another attempt can never turn into an accept (kind not
 * allowed, already have it) is not missing: see isRetryableRelayFailure.
 *
 * A non-array (a mocked or older `publishSigned` that resolves nothing) means
 * "no per-relay detail available" — treated as fully delivered, because the
 * alternative is re-sending an event forever on no evidence at all.
 */
function stillMissing(outcomes: RelayPublishOutcome[] | undefined): string[] {
  if (!Array.isArray(outcomes)) return [];
  return outcomes
    .filter((o) => !o.ok && isRetryableRelayFailure(o.reason))
    .map((o) => o.url);
}

/**
 * How long an item waits after `queuedAt` before its Nth durable flush attempt.
 *
 * Attempts used to be spent per FLUSH, not per unit of time, and the flush runs
 * on every `online` event. Captive-portal Wi-Fi at a venue flaps — the phone
 * associates, the portal drops it, it re-associates — and five of those
 * transitions inside a minute burned all five attempts against a network that
 * was never actually usable, parking the user's join request as terminal
 * `failed` behind a Retry button in a Sync Status panel most people never open.
 *
 * Gating on wall-clock instead means five attempts span at least fifteen
 * minutes, which is long enough for a real network to appear. Indexed by
 * `attempts`, so attempt 0 (the first) is always allowed immediately: a freshly
 * queued item still goes out the moment connectivity returns.
 */
const FLUSH_BACKOFF_MS = [0, 15_000, 60_000, 5 * 60_000, 15 * 60_000];

/**
 * The clock the backoff runs from. `lastAttemptAt` when we have one, else
 * `queuedAt` — measuring from `queuedAt` alone would leave an item queued
 * yesterday (its whole schedule already in the past) able to burn all five
 * attempts in one minute of flapping, which is the exact failure this closes.
 * `lastAttemptAt` is absent on items written by an older build; those get one
 * immediate attempt and are then on the real schedule.
 */
function readyToFlush(item: QueuedItem, now: number): boolean {
  const attempts = item.attempts ?? 0;
  const wait = FLUSH_BACKOFF_MS[Math.min(attempts, FLUSH_BACKOFF_MS.length - 1)] ?? 0;
  return now >= (item.lastAttemptAt ?? item.queuedAt) + wait;
}

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
        const outcomes = await publishSigned(event, relays);
        await queueUndelivered(event, outcomes);
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
 * A publish that reached at least one relay but not all of them leaves the event
 * present on some relays and absent from others — and because success is declared
 * at the first ack, nothing used to notice. A reader that happens to ask only the
 * relays that missed it sees nothing at all, which for a replaceable authority
 * event (an event's config, its roster, a directory entry) reads as "this doesn't
 * exist" rather than "one relay is behind".
 *
 * So the relays that missed it are carried in the durable outbox and topped up
 * later. Only failures that another attempt could fix are queued: a relay that
 * refuses the kind outright, or already holds the event, is not a straggler
 * (see isRetryableRelayFailure).
 *
 * Never throws — it runs inside `publishOrQueue`'s try, where an escaping error
 * would be read as a failed publish and send the whole event again.
 */
async function queueUndelivered(
  event: VerifiedEvent,
  outcomes: RelayPublishOutcome[],
): Promise<void> {
  try {
    if (!backend) return;
    const missing = stillMissing(outcomes);
    if (missing.length === 0) return;
    // A point read, not a full-store scan: this runs on every successful publish
    // and only ever asks about this one event id.
    const existing = await getOne(event.id);
    // An item already waiting to be sent in full outranks topping up stragglers:
    // it targets every relay anyway, and the store is keyed by event id, so
    // writing over it would narrow that publish to this partial relay set.
    if (existing && !existing.partial) return;
    await backend.put({
      event,
      relays: [...new Set([...(existing?.relays ?? []), ...missing])],
      queuedAt: existing?.queuedAt ?? Date.now(),
      attempts: existing?.attempts ?? 0,
      partial: true,
      owner: activeCacheOwner() ?? event.pubkey,
    });
  } catch {
    /* convergence is best-effort; the event is already out on at least one relay */
  }
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
  const now = Date.now();
  const items = (await backend.getAll()).sort((a, b) => a.queuedAt - b.queuedAt);
  let sent = 0;
  // Tallied as we go rather than re-reading the whole store afterwards: the
  // closing `getAll()` was a second full-store deserialize per flush purely to
  // count rows we had just written ourselves.
  let remaining = 0;
  let failedCount = 0;
  /** Record an item's post-flush state for the FlushResult (U1 visibility rules). */
  const tally = (item: QueuedItem, stillQueued: boolean, isFailed: boolean) => {
    if (!stillQueued || item.partial) return; // convergence work is not user-visible
    if (isFailed) failedCount++;
    else remaining++;
  };
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
    if (item.failed) {
      tally(item, true, true); // terminal — never auto-retried
      continue;
    }
    // Attempts are spent on TIME, not on flush calls (see FLUSH_BACKOFF_MS): a
    // burst of `online` events from a flapping captive portal must not exhaust
    // an item's five attempts inside a minute.
    if (!readyToFlush(item, now)) {
      tally(item, true, false);
      continue;
    }
    try {
      const missing = stillMissing(await publishSigned(item.event, item.relays));
      if (missing.length === 0) {
        await backend.delete(item.event.id);
        sent++;
        continue;
      }
      // The event IS out — `publishSigned` only resolves once a relay acked — but
      // some of this item's targets still don't have it. Deleting here is what the
      // straggler redelivery used to do, which made the redelivery itself 1-of-N:
      // an item carrying an event to three relays that missed it was dropped the
      // moment ONE of them accepted, and the other two never got it. Nobody could
      // learn of it either, because a `partial` item is deliberately invisible in
      // the outbox. So narrow the target set to what is still missing and keep
      // going; the action itself counts as sent.
      sent++;
      const attempts = (item.attempts ?? 0) + 1;
      if (attempts >= MAX_FLUSH_ATTEMPTS) {
        // Same policy as an unreachable straggler below: give up quietly.
        await backend.delete(item.event.id).catch(() => {});
        continue;
      }
      await backend
        .put({
          ...item,
          relays: missing,
          attempts,
          lastAttemptAt: now,
          failed: false,
          partial: true,
        })
        .catch(() => {});
    } catch (e) {
      const attempts = (item.attempts ?? 0) + 1;
      const failed = attempts >= MAX_FLUSH_ATTEMPTS;
      // A straggler relay that stayed unreachable is given up on quietly. The
      // event itself was published; parking it as `failed` would put an item in
      // the outbox the user can only be confused by, since the action it
      // describes already succeeded.
      if (failed && item.partial) {
        await backend.delete(item.event.id).catch(() => {});
        continue;
      }
      const lastError = e instanceof Error ? e.message : String(e);
      await backend
        .put({ ...item, attempts, lastAttemptAt: now, failed, lastError })
        .catch(() => {});
      tally(item, true, failed);
    }
  }
  return { sent, remaining, failed: failedCount };
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
    .filter((i) => ownedBy(i, active) && !i.partial)
    .sort((a, b) => a.queuedAt - b.queuedAt);
}

/**
 * How many items (pending + failed) the given account has queued (U1). Partial
 * redeliveries don't count: this drives the logout warning about unsent actions,
 * and those actions were sent.
 */
export async function countQueuedForOwner(owner: string): Promise<number> {
  if (!backend) return 0;
  return (await backend.getAll()).filter((i) => i.owner === owner && !i.partial).length;
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
    const item = await getOne(id);
    // `lastAttemptAt` is cleared along with the counter: the user asking again IS
    // the signal that it's worth another try now, so the backoff must not make an
    // explicit Retry sit and do nothing.
    if (item?.failed) {
      await backend.put({ ...item, failed: false, attempts: 0, lastAttemptAt: undefined });
    }
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
    const now = Date.now();
    void backend
      ?.getAll()
      .then((items) => {
        // Only sweep when the ACTIVE account has something non-terminal pending —
        // another account's queued items must not keep the flusher busy (U1) —
        // and only when at least one of them is actually due (FLUSH_BACKOFF_MS),
        // so a backed-off item doesn't take the flush lock every minute to
        // decide it has nothing to do.
        if (items.some((i) => !i.failed && ownedBy(i, active) && readyToFlush(i, now))) {
          void flushQueue();
        }
      })
      .catch(() => {});
  }, FLUSH_INTERVAL_MS);
}
