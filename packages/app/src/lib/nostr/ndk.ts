/**
 * NDK singleton + relay wiring (spec §10.1). Uses the Dexie (IndexedDB) cache so
 * roster/directory/matches/profiles are available offline (spec §10.4).
 *
 * We sign events with the app's own signer (see signer/), then hand the already
 * signed event to NDK for publishing — NDK is our relay transport, not our signer.
 */
import NDK, { NDKEvent, NDKRelaySet, NDKSubscriptionCacheUsage } from "@nostr-dev-kit/ndk";
import type { NDKFilter, NDKSubscription } from "@nostr-dev-kit/ndk";
import NDKCacheAdapterDexie from "@nostr-dev-kit/cache-dexie";
import type { VerifiedEvent } from "nostr-tools/pure";
import { DEFAULT_RELAYS, DEFAULT_READ_RELAYS, unionRelays } from "./relays.js";

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

/** Get (lazily creating) the NDK singleton. Safe to call before connect(). */
export function getNdk(): NDK {
  if (ndk) return ndk;
  ndk = new NDK({
    explicitRelayUrls: unionRelays(DEFAULT_RELAYS, DEFAULT_READ_RELAYS),
    cacheAdapter:
      typeof indexedDB !== "undefined"
        ? new NDKCacheAdapterDexie({ dbName: "nostrautica-cache" })
        : undefined,
    autoConnectUserRelays: false,
  });
  return ndk;
}

/** Connect to relays (idempotent enough for app boot). */
export async function connectNdk(): Promise<NDK> {
  const instance = getNdk();
  await instance.connect(2000);
  return instance;
}

/** Add relay URLs to the pool at runtime (event 31600 relays, user 10002). */
export function addRelays(urls: string[]): void {
  const instance = getNdk();
  for (const url of urls) {
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

/** One-shot fetch of matching events (uses cache first, then relays). */
export async function fetchEvents(
  filters: Filter | Filter[],
  relays?: string[],
): Promise<NDKEvent[]> {
  const set = await getNdk().fetchEvents(filters as unknown as NDKFilter | NDKFilter[], {
    closeOnEose: true,
    relaySet: relaySet(relays),
  });
  return [...set];
}

/**
 * One-shot fetch that bypasses the dexie cache adapter entirely. Use for
 * must-not-miss reads (gift-wrap grants): with the async cache adapter in the
 * loop, fetchEvents can resolve on EOSE before a relay event that already
 * arrived is surfaced — the grant then sits invisible until some later fetch.
 */
export async function fetchEventsRelayOnly(
  filters: Filter | Filter[],
  relays?: string[],
): Promise<NDKEvent[]> {
  const set = await getNdk().fetchEvents(filters as unknown as NDKFilter | NDKFilter[], {
    closeOnEose: true,
    cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
    relaySet: relaySet(relays),
  });
  return [...set];
}

export { NDKEvent };
