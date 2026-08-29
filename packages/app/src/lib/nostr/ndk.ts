/**
 * NDK singleton + relay wiring (spec §10.1). Uses the Dexie (IndexedDB) cache so
 * roster/directory/matches/profiles are available offline (spec §10.4).
 *
 * We sign events with the app's own signer (see signer/), then hand the already
 * signed event to NDK for publishing — NDK is our relay transport, not our signer.
 */
import NDK, {
  NDKEvent,
  NDKRelaySet,
  NDKRelayStatus,
  calculateRelaySetFromEvent,
} from "@nostr-dev-kit/ndk";
import type { NDKFilter, NDKRelay, NDKSubscription } from "@nostr-dev-kit/ndk";
import NDKCacheAdapterDexie from "@nostr-dev-kit/cache-dexie";
import type { VerifiedEvent } from "nostr-tools/pure";
import { DEFAULT_RELAYS, DEFAULT_READ_RELAYS, unionRelays } from "./relays.js";
import { streamEvents } from "./stream.js";
import { noteRelayPublishFailure } from "./errors.js";

/**
 * A relay filter using plain numeric kinds (Nostrautica's custom kinds aren't in
 * NDK's NDKKind enum). Cast to NDKFilter at the call boundary.
 */
export interface Filter {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  "#p"?: string[];
  "#d"?: string[];
  "#a"?: string[];
  "#e"?: string[];
  "#t"?: string[]; // NIP-12 hashtags — external long-form feeds (§7.4 `sources`)
}

let ndk: NDK | null = null;

/**
 * Dexie cache DB name. BUMP THIS whenever a change makes already-persisted
 * entries unusable — cache-dexie can neither delete nor refresh a bad row
 * (see the comment in getNdk), so a rename is the only reliable reset.
 *
 * v2 (2026-07-21): entries written before `saveSig: true` carry no signature
 * and fail the APPK-1 re-verification on every read, permanently wedging any
 * browser that used the app before that fix.
 */
const CACHE_DB_NAME = "nostrautica-cache-v2";

/** DB names retired by a CACHE_DB_NAME bump — dropped once, on startup. */
const LEGACY_CACHE_DB_NAMES = ["nostrautica-cache"];

/**
 * Delete retired cache DBs so a rename doesn't leave the old (often multi-MB)
 * IndexedDB database behind forever. Best-effort and non-blocking: a blocked
 * delete (another tab still holds the DB open) just retries on the next load,
 * and any failure is irrelevant — the app never reads these again.
 */
export function dropLegacyCacheDb(): void {
  if (typeof indexedDB === "undefined") return;
  for (const name of LEGACY_CACHE_DB_NAMES) {
    try {
      indexedDB.deleteDatabase(name);
    } catch {
      /* storage denied / private mode — harmless, it's already unreachable */
    }
  }
}

/**
 * Seconds a `created_at` may run ahead of our clock before NDK drops the event
 * (audit APPK-1). Ordering-sensitive picks (latest 31600/31923/roster) are
 * latest-by-created_at, so a forged far-future timestamp would win every
 * "latest" pick; 15 min passes honest clock skew but rejects those.
 */
const FUTURE_TIMESTAMP_GRACE_SEC = 900;

/** Get (lazily creating) the NDK singleton. Safe to call before connect(). */
export function getNdk(): NDK {
  if (ndk) return ndk;
  dropLegacyCacheDb();
  ndk = new NDK({
    explicitRelayUrls: unionRelays(DEFAULT_RELAYS, DEFAULT_READ_RELAYS),
    cacheAdapter:
      typeof indexedDB !== "undefined"
        ? // saveSig: true — cache-dexie strips `sig` by default (saves a little
          // storage). Without it, `onlyVerified()`'s authority-boundary
          // re-verification (audit APPK-1) rejects EVERY cache-served event —
          // sig-less can never pass verifyEvent() — breaking the app's own
          // cache-first architecture (a config/roster read that hits the local
          // cache instead of a fresh relay reply throws "not found").
          //
          // The DB name is versioned because entries written before saveSig was
          // set are UNFIXABLE IN PLACE, for two independent reasons found while
          // debugging the 2026-07-21 incident (both verified against
          // cache-dexie 2.7.8's source and a live production cache dump):
          //
          //  1. Nothing can delete them. deleteEventIds() runs
          //     `db.events.where({ id: eventIds }).delete()` — but Dexie's
          //     object form of where() is an EQUALITY match, comparing the `id`
          //     column against the whole array as a single key. It never
          //     matches a string id, so the row survives in IndexedDB and is
          //     reloaded into the in-memory cache on the next page load.
          //  2. Nothing overwrites them either. When a relay delivers the real,
          //     validly-signed copy of an event NDK already served from cache,
          //     NDK treats it as a duplicate and calls setEventDup() (relay
          //     provenance only) instead of setEvent(), so the sig-less row is
          //     never rewritten.
          //
          // Hence the rename: start clean rather than fight a cache that can be
          // neither purged nor refreshed. The old DB is dropped on startup
          // (see dropLegacyCacheDb) so it doesn't linger as dead storage.
          new NDKCacheAdapterDexie({ dbName: CACHE_DB_NAME, saveSig: true })
        : undefined,
    autoConnectUserRelays: false,
    // Audit APPK-1: NDK's default signature-validation ratio decays toward 0.1
    // per relay after ~100 validated events — a malicious relay could then feed
    // us forged E_id/coordinator events. Pin the ratio at 1 so EVERY relay event
    // is signature-verified, always. The authority boundaries additionally
    // re-verify the events they trust (see nostr/verify.ts).
    initialValidationRatio: 1,
    lowestValidationRatio: 1,
    futureTimestampGrace: FUTURE_TIMESTAMP_GRACE_SEC,
  });
  return ndk;
}

/**
 * Relay-connection lifecycle for the connectivity banner (§7.4.6, item 5).
 * `relayHealth()` must distinguish "we haven't even tried to reach a relay yet"
 * (the logged-out home page never calls connectNdk — nothing is deferred-lazy
 * about it, it simply hasn't happened) from "we tried and every relay failed"
 * (the conference-WiFi lie). Claiming "relay-blocked" before a single socket has
 * been attempted is a false positive that scared logged-out visitors on prod.
 *
 *   idle       — connectNdk has never been called (no attempt); NO banner.
 *   connecting — an attempt is in flight, none connected yet;               NO banner.
 *   connected  — at least one relay socket is open right now;               OK.
 *   failed     — a bounded connect() has returned with zero relays open;    relay-blocked.
 */
let relayConnectAttempted = false;
let relayConnectInFlight = 0;

export type RelayHealth = "idle" | "connecting" | "connected" | "failed";

/** Current relay-connection health (see the state machine above). Never throws. */
export function relayHealth(): RelayHealth {
  // Live + authoritative: an open socket right now is "connected" regardless of
  // prior history, so the banner clears promptly the moment a relay (re)connects.
  if (connectedRelayCount() > 0) return "connected";
  if (!relayConnectAttempted) return "idle";
  return relayConnectInFlight > 0 ? "connecting" : "failed";
}

/** Test-only: reset the relay-connection lifecycle flags. */
export function __resetRelayHealthForTests(): void {
  relayConnectAttempted = false;
  relayConnectInFlight = 0;
}

/** Connect to relays (idempotent enough for app boot). */
export async function connectNdk(): Promise<NDK> {
  const instance = getNdk();
  relayConnectAttempted = true;
  relayConnectInFlight += 1;
  try {
    await instance.connect(2000);
    return instance;
  } finally {
    relayConnectInFlight -= 1;
  }
}

/**
 * How many relays are currently connected (audit §7.4.6 — real relay health, not
 * just navigator.onLine). Conference Wi-Fi often reports online while blocking
 * WSS, so a 0 here with the browser "online" is the tell. Never throws; returns 0
 * before the pool exists.
 */
export function connectedRelayCount(): number {
  try {
    return ndk?.pool?.connectedRelays().length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * A relay URL the app will actually open (audit APPR-8): `wss://` only —
 * plaintext `ws://` to a remote host would expose all event traffic to
 * interception. The one exception is loopback (`ws://localhost` / `127.0.0.1` /
 * `[::1]`), which the local e2e/dev stack uses for its dockerized relay.
 */
export function isAcceptedRelayUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "wss:") return true;
    if (u.protocol !== "ws:") return false;
    return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Bounded event-relay growth (audit U16). Every visited event calls `addRelays`
 * with its 31600/10002 relays; before this, nothing ever removed them, so a
 * long-lived client accumulated one socket per event it had ever opened and kept
 * leaking its future activity (subscriptions, publishes to the whole pool) to
 * relays of unrelated past events. We now cap the dynamically-added relays with a
 * least-recently-used eviction, so the pool converges instead of growing without
 * bound. The app's PERMANENT relays (defaults + read defaults) are never tracked
 * or evicted; only event-discovered relays are. Reads that need a specific
 * relay set still pass explicit URLs (see `relaySet`), which re-adds on demand,
 * so eviction never breaks the monotonic publisher's relay-only reads.
 */
const MAX_DYNAMIC_RELAYS = 20;

/** Normalize a relay URL for stable identity across add/remove (trailing slash). */
function normalizeRelay(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

const PERMANENT_RELAYS = new Set(
  unionRelays(DEFAULT_RELAYS, DEFAULT_READ_RELAYS).map(normalizeRelay),
);

/** Event-discovered relays in LRU order (oldest first). Value is a monotonic seq. */
const dynamicRelays = new Map<string, number>();
let relaySeq = 0;

/** Add relay URLs to the pool at runtime (event 31600 relays, user 10002). */
export function addRelays(urls: string[]): void {
  const instance = getNdk();
  for (const url of urls) {
    if (!isAcceptedRelayUrl(url)) continue;
    let addedUrl: string;
    try {
      // Prefer NDK's own normalized url for the relay it actually pooled, so a
      // later removeRelay targets exactly the same key it stored.
      const relay = instance.addExplicitRelay(url);
      addedUrl = relay?.url ?? normalizeRelay(url);
    } catch {
      continue; // malformed URL — never tracked
    }
    if (PERMANENT_RELAYS.has(addedUrl) || PERMANENT_RELAYS.has(normalizeRelay(url))) continue;
    // Refresh recency: delete + re-insert moves this relay to the newest end.
    dynamicRelays.delete(addedUrl);
    dynamicRelays.set(addedUrl, ++relaySeq);
    while (dynamicRelays.size > MAX_DYNAMIC_RELAYS) {
      const oldest = dynamicRelays.keys().next().value as string;
      dynamicRelays.delete(oldest);
      try {
        instance.pool?.removeRelay(oldest);
      } catch {
        /* relay already gone / pool unavailable — nothing to evict */
      }
    }
  }
}

/** Test-only: how many event-discovered relays are currently tracked. */
export function __dynamicRelayCount(): number {
  return dynamicRelays.size;
}

/** Test-only: reset the dynamic-relay LRU between cases. */
export function __resetDynamicRelaysForTests(): void {
  dynamicRelays.clear();
  relaySeq = 0;
}

/** Build an NDKRelaySet from explicit URLs (or undefined for the whole pool). */
export function relaySet(urls?: string[]): NDKRelaySet | undefined {
  if (!urls || urls.length === 0) return undefined;
  return NDKRelaySet.fromRelayUrls(urls, getNdk());
}

/**
 * Per-relay publish budget. Matches NDK's own `NDKRelay.publish` default (2500 ms)
 * so switching to our own fan-out (below) didn't change how long a publish waits
 * on a slow relay.
 */
const RELAY_PUBLISH_TIMEOUT_MS = 2500;

/** What one relay did with the event. `ok:false` is normal, never fatal. */
export interface RelayPublishOutcome {
  url: string;
  ok: boolean;
  /** The relay's OK=false reason, or the transport/timeout message. */
  reason?: string;
}

/**
 * Publish to ONE relay. Resolves — always. It never rejects, and no callback it
 * installs ever re-throws.
 *
 * This exists because NDK's own per-relay path cannot satisfy that. Firefox,
 * 2026-07-28: with "pause on exceptions" on, publishing any 31600/31601/kind-5
 * halted the debugger on `Error: blocked: kind 5 is not accepted by this relay`
 * — a chat-enabled event's relay set includes the two whitenoise relays, which
 * accept only kinds 0/3/445/1059/10000/10002/10050/30443 and refuse everything
 * else with exactly that message. NDK's `NDKRelayPublisher.publish` funnels every
 * per-relay failure through `.catch(onError)` where `onError` ends in a bare
 * `throw err`. Re-throwing inside a promise reaction handler has no catch scope
 * that a JS debugger can see (the only `try` around it is in the engine's
 * self-hosted promise job, which is invisible to the Debugger API), so Firefox
 * classifies it as uncaught and pauses — even though NDK's `NDKRelaySet.publish`
 * does then handle the resulting rejection. Hence: our own fan-out, built on
 * `relay.connectivity.publish`, which merely REJECTS a promise we hand a handler
 * to at creation. A rejection with a handler attached is not an exception and
 * never pauses a debugger, whereas `throw` inside a handler always does.
 *
 * (Empirically checked first: NDK 3.0.3's publish path was driven against local
 * relays that refuse the kind fast, refuse it after the publish timeout, accept
 * it, go silent, close mid-publish, or demand AUTH — with the app's retry loop on
 * top — and produced zero unhandled rejections. So the guard in errors.ts was
 * never going to see these: the debugger pause is the `throw`, not an orphan.)
 */
function publishToRelay(relay: NDKRelay, ndkEvent: NDKEvent): Promise<RelayPublishOutcome> {
  return new Promise<RelayPublishOutcome>((resolve) => {
    let settled = false;
    const finish = (ok: boolean, reason?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      relay.removeListener("connect", onConnect);
      // Diagnosable but quiet: a refusal is expected operating conditions, not an
      // app error, so it goes to console.debug (see noteRelayPublishFailure).
      if (!ok) noteRelayPublishFailure(relay.url, reason);
      resolve({ url: relay.url, ok, reason });
    };
    // A relay that never answers (stale socket, WSS silently dropped) would leave
    // connectivity.publish pending forever — this is the only thing that bounds it.
    const timer = setTimeout(
      () => finish(false, `Timeout: ${RELAY_PUBLISH_TIMEOUT_MS}ms`),
      RELAY_PUBLISH_TIMEOUT_MS,
    );
    const send = (): void => {
      let pending: Promise<unknown>;
      try {
        pending = relay.connectivity.publish(ndkEvent.rawEvent());
      } catch (err) {
        finish(false, messageOf(err));
        return;
      }
      // BOTH handlers attached at creation, in the same expression that creates
      // the promise: there is no window in which this rejection is unobserved,
      // and neither handler re-throws.
      pending.then(
        () => {
          markPublished(relay, ndkEvent);
          finish(true);
        },
        (err) => finish(false, messageOf(err)),
      );
    };
    const onConnect = (): void => send();
    if (relay.status >= NDKRelayStatus.CONNECTED) {
      send();
    } else {
      relay.on("connect", onConnect);
      // NDK's own relay-set builder fires this unawaited (an orphan rejection
      // whenever a relay is unreachable); ours carries its handler.
      void relay.connect().catch(() => {
        /* the timeout above reports it — nothing else to do */
      });
    }
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Re-emit the acceptance signals NDK's own publisher emits, so anything listening
 * on the relay/event (NDK internals, cache adapters) sees the same lifecycle. A
 * listener that throws must not become this publish's problem — hence the guard.
 */
function markPublished(relay: NDKRelay, ndkEvent: NDKEvent): void {
  try {
    relay.emit("published", ndkEvent);
    ndkEvent.emit("relay:published", relay);
    getNdk().subManager?.seenEvent(ndkEvent.id, relay);
  } catch {
    /* a misbehaving listener never fails the publish */
  }
}

/**
 * Publish an already-signed event to the given relays (or the default pool).
 * Succeeds if it reaches at least one relay; per-relay failures (rate limits,
 * timeouts, PoW/auth, "this relay doesn't take that kind") are expected and
 * non-fatal. Throws only if the event reached zero relays (so the caller can
 * queue it for a retry).
 *
 * Relay SELECTION is unchanged: an explicit list still goes through `relaySet`,
 * and an absent one still goes through NDK's `calculateRelaySetFromEvent` — the
 * same call `NDKEvent.publish` makes internally.
 *
 * Deliberately NOT carried over from `NDKEvent.publish`: its
 * `cacheAdapter.addUnpublishedEvent` bookkeeping. Nothing reads it back (no
 * caller of `getUnpublishedEvents` exists in NDK or here) and this app has its
 * own durable outbox — see publish-queue.ts, which is what actually re-sends a
 * failed publish.
 */
export async function publishSigned(
  event: VerifiedEvent,
  relays?: string[],
): Promise<RelayPublishOutcome[]> {
  const instance = getNdk();
  const ndkEvent = new NDKEvent(instance, event as any);
  const set = relaySet(relays) ?? (await calculateRelaySetFromEvent(instance, ndkEvent, 1));
  const targets = [...set.relays];
  if (targets.length === 0) throw new Error("Not enough relays received the event (no relays)");

  // Optimistic local echo, exactly as NDKEvent.publish does it: live subscriptions
  // see the event immediately instead of waiting for it to come back off a relay.
  instance.subManager?.dispatchEvent(ndkEvent.rawEvent(), undefined, true);
  // NIP-09: a deletion invalidates its targets in the local cache. Fire-and-forget
  // like NDK, but WITH a handler — NDK calls this unawaited (twice), which for a
  // rejecting cache adapter is an orphan rejection on every kind-5 publish.
  if (instance.cacheAdapter?.deleteEventIds) {
    void Promise.resolve(
      instance.cacheAdapter.deleteEventIds(
        ndkEvent.tags.filter((t) => t[0] === "e").map((t) => t[1] as string),
      ),
    ).catch(() => {
      /* cache hygiene only — never affects whether the deletion was published */
    });
  }

  // Every per-relay promise is created with its handlers already attached, so a
  // relay refusing the kind can neither reject into the void nor throw.
  const outcomes = await Promise.all(targets.map((relay) => publishToRelay(relay, ndkEvent)));
  const accepted = outcomes.filter((o) => o.ok);
  ndkEvent.publishStatus = accepted.length > 0 ? "success" : "error";
  if (accepted.length > 0) return outcomes;

  // Zero relays took it. Keep NDK's wording — isBenignRelayError and the outbox UI
  // both key off "not enough relays received", and publishOrQueue turns this into
  // a durable queue entry rather than a lost event.
  throw new Error(
    `Not enough relays received the event (0 published, 1 required): ` +
      outcomes.map((o) => `${o.url}: ${o.reason ?? "declined"}`).join("; "),
  );
}

/** Subscribe with a filter; caller handles events and cleanup. */
export function subscribe(
  filters: Filter | Filter[],
  onEvent: (event: NDKEvent) => void,
  relays?: string[],
): NDKSubscription {
  const sub = getNdk().subscribe(filters as unknown as NDKFilter | NDKFilter[], {
    closeOnEose: false,
    relaySet: relaySet(relays),
  });
  sub.on("event", onEvent);
  return sub;
}

/** One-shot fetch of matching events (uses cache first, then relays).
 *
 * UX-1: implemented on the streamEvents collector, NOT NDK's `fetchEvents` —
 * NDK's aggregated EOSE needs ≥2 EOSEs from ≥50% of CONNECTED relays and never
 * fires with zero connected, so a dead-relay majority (conference Wi-Fi with
 * WSS blocked) hung every cold-visit screen forever. The collector settles at
 * first-EOSE+grace / all-connected-relays-EOSE+grace / an 8s hard timeout,
 * whichever comes first, resolving with whatever arrived (partial results).
 * Cache-first semantics are unchanged: the default CACHE_FIRST subscription
 * feeds dexie hits through the same event stream, so a timeout never turns a
 * cache hit into "nothing exists" (and callers treat empty as fail-soft).
 */
export async function fetchEvents(
  filters: Filter | Filter[],
  relays?: string[],
  opts: { timeoutMs?: number; graceMs?: number } = {},
): Promise<NDKEvent[]> {
  return streamEvents(filters, { relays, ...opts }).ready;
}

/**
 * One-shot fetch that bypasses the dexie cache adapter entirely. Use for
 * must-not-miss reads (gift-wrap grants): with the async cache adapter in the
 * loop, fetchEvents can resolve on EOSE before a relay event that already
 * arrived is surfaced — the grant then sits invisible until some later fetch.
 * Time-bounded exactly like `fetchEvents` (UX-1).
 */
export async function fetchEventsRelayOnly(
  filters: Filter | Filter[],
  relays?: string[],
  opts: { timeoutMs?: number; graceMs?: number } = {},
): Promise<NDKEvent[]> {
  return streamEvents(filters, { relays, relayOnly: true, ...opts }).ready;
}

/** Test-only: swap the NDK singleton (pass null to restore lazy creation). */
export function __setNdkForTests(instance: NDK | null): void {
  ndk = instance;
}

export { NDKEvent };
