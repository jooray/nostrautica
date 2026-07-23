/**
 * Reactive "what's new" surface (spec §13): the per-event new-matches badge count
 * (read by EventNav) and the approval banner signal (read by EventHome). Backed by
 * the pure watermark in events/whats-new.ts and the cached decrypted match list.
 *
 * The badge is a PURE read of the cache + watermark — never a $state write. An
 * earlier design cached the count in $state and refreshed it from EventNav; that
 * threw state_unsafe_mutation inside $derived and effect_update_depth_exceeded
 * inside $effect (the write both read and wrote the same rune). Pure compute
 * sidesteps the whole class of Svelte-5 mutation bugs. A tiny epoch signal is
 * bumped only when Matches marks the list seen, so the badge clears without a
 * full page remount.
 */
import { cachedMatches } from "$lib/events/attendee.js";
import {
  loadWatermark,
  saveWatermark,
  newMatchCount,
  approvalIsNew,
} from "$lib/events/whats-new.js";

class WhatsNew {
  /**
   * Bumped when a watermark write changes what "new" means. EventNav's derived
   * reads this so the badge drops to 0 the moment Matches marks the list seen.
   * Nothing else writes it; nothing loops on it.
   */
  private epoch = $state(0);

  /** The new-matches badge count for a coordinate (0 when none/unknown). */
  matchBadge(coordinate: string | undefined): number {
    // Touch epoch so watermark writes invalidate readers.
    void this.epoch;
    if (!coordinate) return 0;
    return newMatchCount(cachedMatches(coordinate), loadWatermark(coordinate));
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
    this.epoch += 1;
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
