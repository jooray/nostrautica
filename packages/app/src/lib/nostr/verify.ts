/**
 * Explicit signature re-verification at the app's authority boundaries (audit
 * APPK-1, defense-in-depth). NDK is pinned to validate every relay event
 * (initialValidationRatio/lowestValidationRatio = 1 in ndk.ts), but the events
 * the app TRUSTS — a latest-by-created_at 31600 config / 31923 details / roster
 * pick, a coordinator announcement — are re-checked here before use, so a
 * forged event is dropped even if it arrived from a poisoned cache or a future
 * NDK regression. Cheap: one Schnorr verify per candidate event.
 */
import { verifyEvent } from "nostr-tools/pure";

/** Minimal signed-event shape `verifyEvent` needs (NDKEvent satisfies it). */
export interface SignedEventLike {
  id: string;
  pubkey: string;
  sig: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** True iff the event's Schnorr signature verifies against its id + pubkey. */
export function isVerified(ev: Partial<SignedEventLike>): boolean {
  try {
    if (!ev.sig) return false;
    return verifyEvent(ev as unknown as Parameters<typeof verifyEvent>[0]);
  } catch {
    return false;
  }
}

/** Drop every event whose signature does not verify. */
export function onlyVerified<T extends Partial<SignedEventLike>>(events: T[]): T[] {
  return events.filter(isVerified);
}

/**
 * Record-authority pinning (NIP §3.7): keep only events authored by one of
 * `authors` (the coordinator currently named in the newest fetchable 31600, plus
 * E_id). A record authored by a FORMERLY assigned coordinator — served from a
 * cache, a hostile relay, or a relay that ignored the author filter — is dropped,
 * so a detached/replaced coordinator's directory/roster/match/talk records stop
 * being trusted the moment a newer config no longer names it. `authors` is
 * empty-safe: an empty allowlist drops everything (fail-closed).
 */
export function onlyByAuthors<T extends Partial<SignedEventLike>>(events: T[], authors: string[]): T[] {
  const allow = new Set(authors);
  return events.filter((e) => e.pubkey !== undefined && allow.has(e.pubkey));
}

/**
 * Keep only events that ARE the addressable record that was asked for: this
 * `kind`, authored by `pubkey`, whose `d` tag is `d` (audit SB-10). A relay is
 * not obliged to honour a `kinds`/`authors`/`#d` filter, and {@link onlyVerified}
 * checks only the Schnorr signature — so a hostile relay could answer the query
 * for `meetup-12`'s 31600 with the same E_id's config for a DIFFERENT `d` (its
 * signature still verifies), and the latest-wins pick would adopt it: the join
 * request is encrypted to the wrong E_inbox and the wrong coordinator is treated
 * as authoritative. The coordinator re-checks the same fields for the same reason.
 *
 * The `d` compared is the FIRST `d` tag, the one NIP-01 addresses by.
 */
export function onlyAddressed<T extends Partial<SignedEventLike>>(
  events: T[],
  kind: number,
  pubkey: string,
  d: string,
): T[] {
  return events.filter(
    (e) => e.kind === kind && e.pubkey === pubkey && e.tags?.find((t) => t[0] === "d")?.[1] === d,
  );
}
