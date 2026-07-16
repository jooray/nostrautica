/**
 * Streaming multi-relay fetch: emit events as they arrive (deduped), resolve a
 * snapshot on first EOSE + a short grace period, and never wait for the slowest
 * relay — a hard timeout always settles the fetch. Late events (within the
 * timeout window) still reach `onEvent`, so reactive callers keep updating.
 *
 * This exists because NDK's aggregated EOSE requires ≥2 relays (and ≥50% of the
 * connected set) before it even arms its own timer — a 2-relay set with one dead
 * relay stalls `fetchEvents` indefinitely.
 */
import { NDKSubscriptionCacheUsage } from "@nostr-dev-kit/ndk";
import type { NDKEvent, NDKFilter, NDKSubscription } from "@nostr-dev-kit/ndk";
import { getNdk, relaySet, type Filter } from "./ndk.js";
import { EventDeduper, type MinimalEvent } from "./dedupe.js";

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
    hardTimer = setTimeout(stop, timeoutMs);
  } catch {
    stop(); // subscribe failed (no relays?) — resolve with whatever we have
  }

  return { ready, stop };
}
