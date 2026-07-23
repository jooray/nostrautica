/**
 * Reactive "what's new" surface (spec §13): the per-event new-matches badge count
 * (read by EventNav) and the approval banner signal (read by EventHome). Backed by
 * the pure watermark in events/whats-new.ts and the cached decrypted match list.
 */
import { cachedMatches } from "$lib/events/attendee.js";
import {
  loadWatermark,
  saveWatermark,
  newMatchCount,
  approvalIsNew,
} from "$lib/events/whats-new.js";

class WhatsNew {
  /** New-matches-since-last-visit, per coordinate. */
  private counts = $state<Record<string, number>>({});

  /** The new-matches badge count for a coordinate (0 when none/unknown). */
  matchBadge(coordinate: string | undefined): number {
    return coordinate ? (this.counts[coordinate] ?? 0) : 0;
  }

  /** Recompute the badge from the cached match list + stored watermark. */
  refreshMatches(coordinate: string): void {
    const wm = loadWatermark(coordinate);
    const next = newMatchCount(cachedMatches(coordinate), wm);
    // Skip no-op writes so a caller that tracked `counts` can't loop.
    if (this.counts[coordinate] === next) return;
    this.counts = { ...this.counts, [coordinate]: next };
  }

  /** Mark the current matches as seen (call when the Matches view is opened). */
  markMatchesSeen(coordinate: string): void {
    const list = cachedMatches(coordinate);
    const wm = loadWatermark(coordinate);
    saveWatermark(coordinate, {
      ...wm,
      seenMatches: (list?.matches ?? []).map((m) => m.pubkey),
      at: Math.floor(Date.now() / 1000),
    });
    if (this.counts[coordinate] === 0) return;
    this.counts = { ...this.counts, [coordinate]: 0 };
  }

  /** True when approval happened since the last visit (drives the banner). */
  approvalIsNew(coordinate: string, approved: boolean): boolean {
    return approvalIsNew(approved, loadWatermark(coordinate));
  }

  /** Record that the approval banner has been shown (so it doesn't recur). */
  markApprovedSeen(coordinate: string): void {
    const wm = loadWatermark(coordinate);
    if (wm.seenApproved) return;
    saveWatermark(coordinate, { ...wm, seenApproved: true, at: Math.floor(Date.now() / 1000) });
  }
}

export const whatsNew = new WhatsNew();
