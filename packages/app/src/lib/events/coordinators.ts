/**
 * Coordinator discovery (docs/COORDINATOR-DISCOVERY-PLAN.md). Coordinators
 * publish a public, replaceable kind-31611 announcement; organizers pick one from
 * the list instead of pasting an npub (they still can). No trust is implied by
 * listing — announcements are self-published; the UI marks the curated default.
 */
import {
  KIND_COORDINATOR_ANNOUNCE,
  coordinatorAnnounceSchema,
  type CoordinatorAnnounce,
} from "@nostrautica/protocol";
import { npubEncode } from "nostr-tools/nip19";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { cacheGet, cacheSet, ANON } from "$lib/cache/persist.js";

export interface DiscoveredCoordinator {
  pubkey: string; // hex
  npub: string;
  announce: CoordinatorAnnounce;
  createdAt: number;
}

// The coordinator picker (kind 31611) is public and changes rarely — cache it
// under the anon scope with a 1 h TTL (CACHING-PLAN §2.11).
const COORDINATORS_KEY = "coordinators";
const COORDINATORS_TTL_SEC = 60 * 60;

/** Cached coordinator list (no network), or undefined. */
export function cachedCoordinators(): DiscoveredCoordinator[] | undefined {
  return cacheGet<DiscoveredCoordinator[]>(COORDINATORS_KEY, ANON)?.data;
}

/**
 * Fetch + parse all coordinator announcements, latest per identity, newest first.
 * Cache-first with a 1 h TTL: a cached list younger than the TTL is returned
 * without a relay round-trip. Pass `{ force }` to bypass the TTL.
 */
export async function fetchCoordinators(
  opts: { force?: boolean } = {},
): Promise<DiscoveredCoordinator[]> {
  const hit = cacheGet<DiscoveredCoordinator[]>(COORDINATORS_KEY, ANON);
  if (!opts.force && hit && Math.floor(Date.now() / 1000) - hit.at < COORDINATORS_TTL_SEC) {
    return hit.data;
  }
  const events = await fetchEvents({ kinds: [KIND_COORDINATOR_ANNOUNCE] }).catch(() => []);
  // Latest per pubkey (replaceable, but relays may return stale copies).
  const latest = new Map<string, (typeof events)[number]>();
  for (const e of events) {
    const prev = latest.get(e.pubkey);
    if (!prev || (e.created_at ?? 0) > (prev.created_at ?? 0)) latest.set(e.pubkey, e);
  }
  const out: DiscoveredCoordinator[] = [];
  for (const e of latest.values()) {
    try {
      const announce = coordinatorAnnounceSchema.parse(JSON.parse(e.content));
      out.push({
        pubkey: e.pubkey,
        npub: npubEncode(e.pubkey),
        announce,
        createdAt: e.created_at ?? 0,
      });
    } catch {
      /* skip malformed announcements */
    }
  }
  const sorted = out.sort((a, b) => b.createdAt - a.createdAt);
  cacheSet(COORDINATORS_KEY, sorted, Math.floor(Date.now() / 1000), ANON);
  return sorted;
}

/** A one-line human pricing summary for a coordinator card. */
export function pricingLabel(a: CoordinatorAnnounce): string {
  const p = a.pricing;
  if (!p || p.model === "free") return "Free";
  if (p.summary) return p.summary;
  if (p.free_up_to_users !== undefined) return `Free up to ${p.free_up_to_users}, then paid`;
  if (p.model === "negotiated") return "Pricing by quote";
  return "Paid";
}

/**
 * Append the event identifier to a coordinator's checkout URL so the checkout
 * page knows what's being paid for (user request 2026-07-17). Merges with any
 * existing query; falls back to the raw URL if it can't be parsed.
 */
export function checkoutUrlForEvent(checkoutUrl: string, naddr: string): string {
  try {
    const u = new URL(checkoutUrl);
    u.searchParams.set("event", naddr);
    return u.toString();
  } catch {
    // Relative or malformed — append manually.
    const sep = checkoutUrl.includes("?") ? "&" : "?";
    return `${checkoutUrl}${sep}event=${encodeURIComponent(naddr)}`;
  }
}
