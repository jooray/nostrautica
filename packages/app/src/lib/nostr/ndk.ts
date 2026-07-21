/**
 * NDK singleton + relay wiring (spec §10.1). Uses the Dexie (IndexedDB) cache so
 * roster/directory/matches/profiles are available offline (spec §10.4).
 *
 * We sign events with the app's own signer (see signer/), then hand the already
 * signed event to NDK for publishing — NDK is our relay transport, not our signer.
 */
import NDK, { NDKEvent, NDKRelaySet } from "@nostr-dev-kit/ndk";
import type { NDKFilter, NDKSubscription } from "@nostr-dev-kit/ndk";
import NDKCacheAdapterDexie from "@nostr-dev-kit/cache-dexie";
import type { VerifiedEvent } from "nostr-tools/pure";
import { DEFAULT_RELAYS, DEFAULT_READ_RELAYS, unionRelays } from "./relays.js";
import { streamEvents } from "./stream.js";

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
}

let ndk: NDK | null = null;

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
          new NDKCacheAdapterDexie({ dbName: "nostrautica-cache", saveSig: true })
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

/** Connect to relays (idempotent enough for app boot). */
export async function connectNdk(): Promise<NDK> {
  const instance = getNdk();
  await instance.connect(2000);
  return instance;
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

/** Add relay URLs to the pool at runtime (event 31600 relays, user 10002). */
export function addRelays(urls: string[]): void {
  const instance = getNdk();
  for (const url of urls) {
    if (!isAcceptedRelayUrl(url)) continue;
    try {
      instance.addExplicitRelay(url);
    } catch {
      /* ignore malformed URLs */
    }
  }
}

/** Build an NDKRelaySet from explicit URLs (or undefined for the whole pool). */
export function relaySet(urls?: string[]): NDKRelaySet | undefined {
  if (!urls || urls.length === 0) return undefined;
  return NDKRelaySet.fromRelayUrls(urls, getNdk());
}

/**
 * Publish an already-signed event to the given relays (or the default pool).
 * Succeeds if it reaches at least one relay; per-relay failures (rate limits,
 * timeouts, PoW/auth) are expected and non-fatal. Throws only if the event
 * reached zero relays (so the caller can queue it for a retry).
 */
export async function publishSigned(
  event: VerifiedEvent,
  relays?: string[],
): Promise<void> {
  const ndkEvent = new NDKEvent(getNdk(), event as any);
  try {
    await ndkEvent.publish(relaySet(relays));
  } catch (err) {
    // NDK throws NDKPublishError only when fewer than 1 relay accepted; but it may
    // also carry partial success. Treat any relay acceptance as success.
    const reached =
      (err as any)?.publishedToRelays?.size ??
      (ndkEvent as any)?.onRelays?.length ??
      0;
    if (reached > 0) return;
    throw err;
  }
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
