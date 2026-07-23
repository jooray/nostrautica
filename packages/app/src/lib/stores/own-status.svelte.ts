/**
 * Reactive store of the signed-in attendee's own coordinator-status notices
 * (kind 21606 sealed to the attendee, NIP §6.3). Keyed by event coordinate. A
 * screen renders `poison` notices for its event as a modest banner ("your talk
 * failed processing — try re-recording"); a `cleared` state removes it.
 */
import type { CoordinatorStatusContent } from "@nostrautica/protocol";

const byCoordinate = $state<Record<string, CoordinatorStatusContent[]>>({});

export const ownStatusStore = {
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
