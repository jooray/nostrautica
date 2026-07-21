/**
 * Streaming multi-relay fetch: emit events as they arrive (deduped), resolve a
 * snapshot on first EOSE + a short grace period, and never wait for the slowest
 * relay — a hard timeout always settles the fetch. Late events (within the
 * timeout window) still reach `onEvent`, so reactive callers keep updating.
 *
 * This exists because NDK's aggregated EOSE requires ≥2 relays (and ≥50% of the
 * connected set) before it even arms its own timer — a 2-relay set with one dead
 * relay stalls `fetchEvents` indefinitely.
 *
 * UX-18: besides the aggregated "eose" and the hard cap, the stream also settles
 * early once EVERY CONNECTED relay in the set has individually EOSEd (via NDK's
 * per-relay `eoseReceived` hook) + grace — a dead relay no longer forces the
 * full timeout on every read in a chain (roster→directory→profiles ≈ 16-24s).
 */
import { NDKSubscriptionCacheUsage } from "@nostr-dev-kit/ndk";
import type { NDKEvent, NDKFilter, NDKSubscription } from "@nostr-dev-kit/ndk";
import { getNdk, relaySet, type Filter } from "./ndk.js";
import { EventDeduper, type MinimalEvent } from "./dedupe.js";
import { isVerified } from "./verify.js";

export interface StreamOptions {
  relays?: string[];
  /** Linger after the first EOSE so near-simultaneous relays still contribute. */
  graceMs?: number;
  /** Hard cap: `ready` resolves and the subscription is torn down by then. */
  timeoutMs?: number;
  /** Bypass the dexie cache (must-not-miss reads, see ndk.ts fetchEventsRelayOnly). */
  relayOnly?: boolean;
  /**
   * Per accepted (deduped) event, including late arrivals after `ready`. When
   * set, the subscription stays open until `stop()` or `timeoutMs` — callers
   * rendering live must still call `stop()` from onDestroy.
   */
  onEvent?: (e: NDKEvent) => void;
}

export interface StreamHandle {
  /** Deduped snapshot at first-EOSE+grace or timeout, whichever comes first. */
  ready: Promise<NDKEvent[]>;
  /** Idempotent; also resolves `ready` if it hasn't settled yet. */
  stop: () => void;
}

export function streamEvents(
  filters: Filter | Filter[],
  opts: StreamOptions = {},
): StreamHandle {
  const { relays, graceMs = 400, timeoutMs = 8000, relayOnly = false, onEvent } = opts;
  const deduper = new EventDeduper();
  const byId = new Map<string, NDKEvent>();
  /** Event ids whose signature already verified in this stream (see below). */
  const verifiedIds = new Set<string>();
  let sub: NDKSubscription | undefined;
  let stopped = false;
  let settled = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;

  let resolveReady!: (v: NDKEvent[]) => void;
  const ready = new Promise<NDKEvent[]>((r) => (resolveReady = r));

  const snapshot = () =>
    deduper
      .snapshot()
      .map((raw) => byId.get(raw.id))
      .filter((e): e is NDKEvent => !!e);

  const settle = () => {
    if (settled) return;
    settled = true;
    if (graceTimer) clearTimeout(graceTimer);
    resolveReady(snapshot());
    // One-shot callers are done — free the subscription. Live callers (onEvent)
    // keep it open for late events until stop() or the hard timeout.
    if (!onEvent) stop();
  };

  const stop = () => {
    if (!stopped) {
      stopped = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (hardTimer) clearTimeout(hardTimer);
      try {
        sub?.stop();
      } catch {
        /* already closed */
      }
    }
    settle(); // a stopped stream must never leave `ready` pending
  };

  const armGrace = () => {
    if (settled || stopped || graceTimer) return;
    graceTimer = setTimeout(settle, graceMs);
  };

  try {
    sub = getNdk().subscribe(filters as unknown as NDKFilter | NDKFilter[], {
      closeOnEose: false,
      groupable: false,
      relaySet: relaySet(relays),
      ...(relayOnly ? { cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY } : {}),
    });
    sub.on("event", (e: NDKEvent) => {
      if (stopped) return;
      const raw = e.rawEvent() as unknown as MinimalEvent;
      // Central signature check (audit APPK-1): every fetch in the app funnels
      // through here, cache hit or fresh relay event alike, so an event that
      // doesn't verify is dropped as if it had never arrived.
      //
      // No cache purge here any more. It used to call
      // `cacheAdapter.deleteEventIds` to self-heal sig-less rows written before
      // `saveSig: true`, but that never worked: cache-dexie's implementation is
      // `db.events.where({ id: eventIds }).delete()`, and Dexie's object form
      // of where() is an EQUALITY match against the whole array, so it never
      // matches a string key. Those rows were retired by versioning the cache
      // DB instead (see ndk.ts CACHE_DB_NAME), which is what actually fixed the
      // 2026-07-21 incident — leaving the purge here would be a broken call on
      // the hot path pretending to be a safety net.
      //
      // Verification is memoized per event id because the same event arrives
      // once per relay (five write relays by default), and a Schnorr verify is
      // ~0.5-1ms of synchronous main-thread work — on a 200-person roster that
      // was hundreds of ms per read, repeated on every navigation, which ate
      // much of what the cache-first architecture buys. The check still runs
      // BEFORE the deduper so an unverified event can never poison its
      // latest-wins state for a replaceable coordinate. Only SUCCESSES are
      // memoized: caching failures would let anyone drop a genuine event by
      // racing a same-id copy carrying a bad signature to us first.
      if (!verifiedIds.has(raw.id)) {
        if (!isVerified(raw as never)) return;
        verifiedIds.add(raw.id);
      }
      if (!deduper.accept(raw)) return;
      byId.set(raw.id, e);
      try {
        onEvent?.(e);
      } catch {
        /* a consumer error must not kill the stream */
      }
    });
    sub.on("eose", () => {
      if (settled || stopped) return;
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = setTimeout(settle, graceMs);
    });
    // UX-18: NDK's "eose" above is AGGREGATED — it needs ≥2 EOSEs from ≥50% of
    // the connected relays, so a 2-relay set with one dead relay pays the full
    // hard timeout on every read (and reads chain: roster→directory→profiles).
    // NDK 3.0.3 emits no per-relay EOSE event, but `eoseReceived(relay)` is its
    // per-relay hook (public method, called exactly once per relay EOSE). Wrap
    // it to resolve early once EVERY CONNECTED relay in the set has EOSEd:
    // `relaysMissingEose()` minus the disconnected ones must be empty. Dead
    // relays simply stop mattering; the grace window + hard cap still apply,
    // and live `onEvent` callers keep receiving late events regardless.
    const origEoseReceived = sub.eoseReceived?.bind(sub);
    if (typeof origEoseReceived === "function" && typeof sub.relaysMissingEose === "function") {
      sub.eoseReceived = (relay: Parameters<typeof origEoseReceived>[0]) => {
        origEoseReceived(relay);
        if (settled || stopped || graceTimer) return;
        try {
          if ((sub?.eosesSeen?.size ?? 0) === 0) return; // nothing executed yet
          const missing = sub?.relaysMissingEose() ?? [];
          if (missing.length === 0) return; // all EOSEd → aggregated eose handles it
          const connected = new Set(getNdk().pool.connectedRelays().map((r) => r.url));
          if (missing.every((url) => !connected.has(url))) armGrace();
        } catch {
          /* NDK internals shifted — aggregated eose + hard timeout still bound us */
        }
      };
    }
    hardTimer = setTimeout(stop, timeoutMs);
  } catch {
    stop(); // subscribe failed (no relays?) — resolve with whatever we have
  }

  return { ready, stop };
}
