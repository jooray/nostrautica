/**
 * Local admission review state (audit UX-A7). An organizer can Reject or
 * Leave-pending a join request; this is LOCAL-ONLY (no protocol action, no
 * attendee notification — the UI says so) and persists per event + owner so an
 * ignored/rejected request stops perpetually looking "new" across reloads.
 *
 *  - "rejected": drop from the pending queue view (still re-approvable — the
 *    attendee's 21601 is still on the relay — but no longer nagging).
 *  - "deferred": keep in the queue but mark reviewed, so it isn't highlighted as
 *    a fresh arrival.
 *
 * Stored in localStorage keyed by coordinate; owner scoping is implicit because
 * only the organizer device holds the E_id/E_inbox needed to see these requests,
 * and the coordinate is event-specific.
 */
export type ReviewState = "rejected" | "deferred";

export type ReviewMap = Record<string, ReviewState>;

function key(coordinate: string): string {
  return `nostrautica:review:${coordinate}`;
}

/** Load the persisted review map for an event (empty when none/unavailable). */
export function loadReview(coordinate: string): ReviewMap {
  try {
    const raw = localStorage.getItem(key(coordinate));
    return raw ? (JSON.parse(raw) as ReviewMap) : {};
  } catch {
    return {};
  }
}

/** Persist a review map (best-effort). */
function persist(coordinate: string, map: ReviewMap): void {
  try {
    localStorage.setItem(key(coordinate), JSON.stringify(map));
  } catch {
    /* storage unavailable — review state stays in memory only */
  }
}

/** Set (or clear, when `state` is undefined) one attendee's review state; returns the new map. */
export function setReview(
  coordinate: string,
  current: ReviewMap,
  pubkey: string,
  state: ReviewState | undefined,
): ReviewMap {
  const next: ReviewMap = { ...current };
  if (state === undefined) delete next[pubkey];
  else next[pubkey] = state;
  persist(coordinate, next);
  return next;
}

/** Pubkeys in a given review state, as a Set (for the queue filter). */
export function pubkeysInState(map: ReviewMap, state: ReviewState): Set<string> {
  return new Set(Object.entries(map).filter(([, s]) => s === state).map(([pk]) => pk));
}
