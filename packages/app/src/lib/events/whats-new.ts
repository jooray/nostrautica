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

/** Match pubkeys in `matches` the watermark hasn't seen yet — the "new" ones. */
export function newMatchPubkeys(matches: MatchListContent | undefined, seen: string[]): string[] {
  if (!matches) return [];
  const seenSet = new Set(seen);
  return matches.matches.map((m) => m.pubkey).filter((p) => !seenSet.has(p));
}

/** How many matches are new since the last visit. */
export function newMatchCount(matches: MatchListContent | undefined, wm: Watermark): number {
  return newMatchPubkeys(matches, wm.seenMatches).length;
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
