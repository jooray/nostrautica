/**
 * Reactive store of the signed-in attendee's own coordinator-status notices
 * (kind 21606 sealed to the attendee, NIP §6.3). Keyed by event coordinate. A
 * screen renders `poison` notices for its event as a modest banner ("your talk
 * failed processing, try re-recording"); a `cleared` state removes it.
 *
 * OWNER-SCOPED. These are one person's private operational state — the
 * coordinator seals them to that attendee precisely so nobody else sees them —
 * and this was a module-level `$state` keyed by coordinate alone that nothing
 * ever reset. On a shared device, A signs out and B signs in, B opens the same
 * event, and `poison()` hands back A's notices: B is shown A's failure. The
 * persisted copy was always owner-scoped (`cacheSet` composite keys); only this
 * in-memory mirror was not.
 *
 * It got worse when the readiness journey started deriving its "failed" step from
 * `poison()`: the leak stopped being a stray banner and became B's stepper saying
 * B's own profile had failed, with a CTA, on the strength of A's notice.
 */
import type { CoordinatorStatusContent } from "@nostrautica/protocol";

const byCoordinate = $state<Record<string, CoordinatorStatusContent[]>>({});
let owner: string | null = null;

export const ownStatusStore = {
  /**
   * Point the store at `pubkey` (or nothing, on logout), dropping everything the
   * previous identity accumulated. Idempotent for the same owner, so a session
   * RESTORE — which re-adopts the same identity — keeps what it already scanned.
   */
  setOwner(pubkey: string | null) {
    if (owner === pubkey) return;
    owner = pubkey;
    for (const k of Object.keys(byCoordinate)) delete byCoordinate[k];
  },
  /** Replace the notices for a coordinate (called from the grant scan). */
  set(coordinate: string, statuses: CoordinatorStatusContent[]) {
    byCoordinate[coordinate] = statuses;
  },
  /** Seed from cache without overwriting fresher scanned values. */
  seed(coordinate: string, statuses: CoordinatorStatusContent[]) {
    if (!byCoordinate[coordinate]) byCoordinate[coordinate] = statuses;
  },
  /** Unresolved poison notices for a coordinate (state !== "cleared"). */
  poison(coordinate: string): CoordinatorStatusContent[] {
    return (byCoordinate[coordinate] ?? []).filter((s) => s.state === "poison");
  },
};
