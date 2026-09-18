/**
 * "What's new" watermark (spec §13). Per-event, owner-scoped, local: what the
 * user had already seen last time they visited — which matches, and whether they
 * were already approved — so the app can surface a new-matches badge and a
 * one-line "you were approved" banner without any wire change. Pure math here;
 * the reactive surface lives in stores/whats-new.svelte.ts.
 */
import type { MatchListContent } from "@nostrautica/protocol";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

export interface Watermark {
  /** Match pubkeys the user had already seen (last time they opened Matches). */
  seenMatches: string[];
  /**
   * Roster pubkeys the user had already seen, last time the People list painted.
   *
   * OPTIONAL, and the absence is load-bearing rather than a migration nicety:
   * `undefined` means this device has never recorded the roster, so there is no
   * "before" to compare against and NOBODY is new. Recording the baseline is
   * what makes the next visit meaningful. An empty array is a different fact —
   * "last time I looked, the roster was empty" — and every arrival since then
   * genuinely is new.
   *
   * Without that distinction the first visit to any event would mark all 200
   * attendees NEW, which says nothing about anyone. Matches deliberately keep
   * the opposite rule (see `newMatchPubkeys`): a match list arriving for the
   * first time IS the news.
   */
  seenPeople?: string[];
  /** True once the "you're approved" banner has been shown for this event. */
  seenApproved: boolean;
  /** When the watermark was last written. */
  at: number;
}

const EMPTY: Watermark = { seenMatches: [], seenApproved: false, at: 0 };

function key(coordinate: string): string {
  return `whatsnew:${coordinate}`;
}

/** The stored watermark for a coordinate, or an empty one. */
export function loadWatermark(coordinate: string): Watermark {
  return cacheGet<Watermark>(key(coordinate))?.data ?? { ...EMPTY };
}

export function saveWatermark(coordinate: string, w: Watermark): void {
  cacheSet(key(coordinate), w, w.at || Math.floor(Date.now() / 1000));
}

/**
 * Match pubkeys in `matches` the watermark hasn't seen yet — the "new" ones.
 *
 * Typed on the minimum it reads rather than on `MatchListContent`, so the People
 * list can ask the same question about a bare `Match[]` it is already holding
 * without first reassembling the envelope (`v`/`computed_at`) around it.
 */
export function newMatchPubkeys(
  matches: { matches: readonly { pubkey: string }[] } | undefined,
  seen: string[],
): string[] {
  if (!matches) return [];
  const seenSet = new Set(seen);
  return matches.matches.map((m) => m.pubkey).filter((p) => !seenSet.has(p));
}

/** How many matches are new since the last visit. */
export function newMatchCount(matches: MatchListContent | undefined, wm: Watermark): number {
  return newMatchPubkeys(matches, wm.seenMatches).length;
}

/**
 * Roster pubkeys that weren't there last time the People list was open.
 *
 * Empty until a baseline exists (see `Watermark.seenPeople`) — a first visit
 * has nothing to compare against.
 */
export function newPeoplePubkeys(
  entries: readonly { pubkey: string }[] | undefined,
  seen: string[] | undefined,
): string[] {
  if (!entries || seen === undefined) return [];
  const seenSet = new Set(seen);
  return entries.map((e) => e.pubkey).filter((p) => !seenSet.has(p));
}

/**
 * Everyone the People list would mark NEW: new matches and new roster arrivals,
 * as ONE set.
 *
 * Deduped on purpose. A new match is almost always a new roster entry too, and
 * counting them twice would make the nav badge say "4" over two marked rows —
 * the badge and the markers have to be the same fact seen from two places, or
 * the badge stops meaning anything.
 */
export function newSincePubkeys(
  matches: { matches: readonly { pubkey: string }[] } | undefined,
  entries: readonly { pubkey: string }[] | undefined,
  wm: Watermark,
): string[] {
  return [
    ...new Set([
      ...newMatchPubkeys(matches, wm.seenMatches),
      ...newPeoplePubkeys(entries, wm.seenPeople),
    ]),
  ];
}

/**
 * Should the "you were approved" banner show? True when the user now holds an ECK
 * (approved) but the watermark hasn't recorded that yet — i.e. approval happened
 * since the last visit (or on this very visit). Idempotent read; the caller marks
 * it seen once shown.
 */
export function approvalIsNew(approved: boolean, wm: Watermark): boolean {
  return approved && !wm.seenApproved;
}
