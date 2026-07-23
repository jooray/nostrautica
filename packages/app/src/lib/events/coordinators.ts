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
  supersedes,
} from "@nostrautica/protocol";
import { npubEncode, decode } from "nostr-tools/nip19";
import { streamEvents } from "$lib/nostr/stream.js";
import { onlyVerified } from "$lib/nostr/verify.js";
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
  // streamEvents, not fetchEvents: NDK's aggregated EOSE needs ≥2 relays before
  // it arms its timer, so on a single-relay stack (or a coordinator-less event)
  // fetchEvents hangs forever — and Admin.svelte awaits this in Promise.allSettled,
  // so a hang means its network-settled mark never fires. streamEvents settles at
  // first-EOSE+grace or the 8 s hard timeout, whichever comes first (see stream.ts).
  const events = await streamEvents(
    { kinds: [KIND_COORDINATOR_ANNOUNCE] },
    { timeoutMs: 8000 },
  ).ready.catch(() => []);
  // Authority boundary (audit APPK-1): re-verify before the latest-per-pubkey
  // pick — announcements are self-published, but a FORGED one (bad sig) is not
  // even self-published.
  const verified = onlyVerified(events);
  // Latest per pubkey (replaceable, but relays may return stale copies).
  const latest = new Map<string, (typeof events)[number]>();
  for (const e of verified) {
    const prev = latest.get(e.pubkey);
    if (!prev || supersedes(e, prev)) latest.set(e.pubkey, e);
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

/**
 * Normalise a coordinator identity the organizer pasted (the "advanced" npub
 * fallback in the picker) to a lowercase 64-char hex pubkey, or null if it isn't
 * a valid npub / hex key. Accepts either an `npub1…` (decoded) or raw hex; this
 * is the same validation the Admin attach path does inline (decode → hex regex),
 * lifted out so the picker and its tests share one parser. Returns null rather
 * than throwing so the caller can show a single "invalid key" hint.
 */
export function parseCoordinatorKey(input: string): string | null {
  let pk = input.trim();
  if (!pk) return null;
  if (pk.startsWith("npub1")) {
    try {
      const decoded = decode(pk);
      if (decoded.type !== "npub") return null;
      pk = decoded.data;
    } catch {
      return null;
    }
  }
  return /^[0-9a-f]{64}$/i.test(pk) ? pk.toLowerCase() : null;
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
 * A coordinator-announcement/billing URL safe to render as a link (audits
 * APPR-1/APPR-2): https: only. `javascript:`/`data:` parse fine with `new URL()`
 * and would otherwise become clickable script execution in Admin. Anything
 * unparseable or non-https is dropped (returns undefined → the UI hides it).
 */
export function httpsUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Append the event identifier to a coordinator's checkout URL so the checkout
 * page knows what's being paid for (user request 2026-07-17). Merges with any
 * existing query. Returns null (link hidden) for anything that isn't an
 * absolute https: URL (audit APPR-2) — the previous fallthrough let a
 * `javascript:` URL sail straight into an <a href>.
 */
export function checkoutUrlForEvent(checkoutUrl: string, naddr: string): string | null {
  const safe = httpsUrl(checkoutUrl);
  if (!safe) return null;
  const u = new URL(safe);
  u.searchParams.set("event", naddr);
  return u.toString();
}
