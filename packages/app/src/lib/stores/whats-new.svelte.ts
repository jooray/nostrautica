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
import { cachedMatches, cachedDirectory } from "$lib/events/attendee.js";
import { cacheHydration } from "$lib/cache/hydration.svelte.js";
import {
  loadWatermark,
  saveWatermark,
  newSincePubkeys,
  approvalIsNew,
} from "$lib/events/whats-new.js";

/** Same members in the same order — both callers store a canonical list. */
function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

class WhatsNew {
  /**
   * Bumped when a watermark write changes what "new" means. EventNav's derived
   * reads this so the badge drops to 0 the moment Matches marks the list seen.
   * Nothing else writes it; nothing loops on it.
   */
  private epoch = $state(0);

  /**
   * How many people the People tab has to show you that you haven't seen: new
   * matches AND new roster arrivals, deduped (`newSincePubkeys`). 0 when
   * none/unknown.
   *
   * One number for one tab. The badge used to count matches only, which left the
   * tab silent about the thing a returning attendee actually comes back for —
   * who else turned up — and left the People list unable to mark anybody, since
   * it had no record of who was there before (user report 2026-09-18).
   */
  peopleBadge(coordinate: string | undefined): number {
    // Touch epoch so watermark writes invalidate readers.
    void this.epoch;
    // …and hydration, so the badge is recomputed when the persisted roster and
    // matches actually land in the mirror. Boot doesn't wait for IndexedDB, so
    // the first read of this can legitimately see an empty cache.
    void cacheHydration.version;
    if (!coordinate) return 0;
    return newSincePubkeys(
      cachedMatches(coordinate),
      cachedDirectory(coordinate),
      loadWatermark(coordinate),
    ).length;
  }

  /**
   * Mark the current matches as seen (call when the People view is opened).
   *
   * A no-op when nothing moved, like `markRosterSeen`: both are called again as
   * their lists stream in, and a write that changes nothing would still bump the
   * epoch and re-run every badge on the screen for no reason.
   */
  markMatchesSeen(coordinate: string): void {
    const list = cachedMatches(coordinate);
    const wm = loadWatermark(coordinate);
    const next = (list?.matches ?? []).map((m) => m.pubkey);
    if (same(wm.seenMatches, next)) return;
    saveWatermark(coordinate, { ...wm, seenMatches: next, at: Math.floor(Date.now() / 1000) });
    this.epoch += 1;
  }

  /**
   * Record the roster as seen — the baseline the NEXT visit compares against.
   *
   * Takes the pubkeys rather than reading the cache itself because the People
   * list streams: it calls this again as entries arrive, so somebody who turned
   * up while the list was open is already accounted for and isn't announced as
   * new tomorrow. Idempotent, and a no-op when the set hasn't changed, so the
   * stream can call it freely.
   */
  markRosterSeen(coordinate: string, pubkeys: string[]): void {
    const wm = loadWatermark(coordinate);
    const next = [...new Set(pubkeys)].sort();
    if (wm.seenPeople && same(wm.seenPeople, next)) return;
    saveWatermark(coordinate, { ...wm, seenPeople: next, at: Math.floor(Date.now() / 1000) });
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
