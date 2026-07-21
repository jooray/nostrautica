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
      // Central signature check (audit APPK-1 + incident 2026-07-21): every
      // fetch in the app funnels through here, cache hit or fresh relay event
      // alike. An event that doesn't verify — most commonly a stale cache
      // entry from before cache-dexie was configured to persist `sig`, but
      // equally a genuinely forged/poisoned one — is purged from the cache and
      // dropped as if it had never arrived. A live subscription keeps running
      // past this point, so a relay serving the real, validly-signed event
      // (which it always will, for a stale-cache miss) still delivers it
      // through this same callback moments later — no separate migration,
      // reload, or re-login needed.
      if (!isVerified(raw as never)) {
        // cache-dexie keys replaceable/addressable events (everything in the
        // 10000-19999 and 30000-39999 ranges — which is most of what this app
        // fetches: 31600, 31923, 31603, 31605...) by `tagId()`
        // ("kind:pubkey:d-tag"), NOT the raw event hash `raw.id`. Deleting by
        // `raw.id` alone is a silent no-op for those — verified against
        // cache-dexie's own setEvent()/deleteEventIds() source, and against a
        // live incident where a stale cache entry survived this exact purge
        // call. Delete both keys so the fix is correct for replaceable AND
        // regular (non-replaceable) kinds without needing to special-case them.
        const ids = [raw.id, e.tagId()];
        void getNdk().cacheAdapter?.deleteEventIds?.(ids);
        return;
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
