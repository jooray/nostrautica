/**
 * Local admission review state (audit UX-A7, re-scoped for audit U11). An
 * organizer can Reject or Leave-pending a join request; this is LOCAL-ONLY (no
 * protocol action, no attendee notification — the UI says so) and persists per
 * event so an ignored/rejected request stops perpetually looking "new" across
 * reloads.
 *
 *  - "rejected": drop from the pending queue view (still re-approvable — the
 *    attendee's 21601 is still on the relay — but no longer nagging).
 *  - "deferred": keep in the queue but mark reviewed, so it isn't highlighted as
 *    a fresh arrival.
 *
 * U11: this used to live in localStorage keyed by coordinate ALONE, so a second
 * organizer account signing in on the same device (shared tablet) inherited the
 * first organizer's private reject/defer decisions and dismissed coordinator
 * statuses. It now lives in the OWNER-SCOPED persistent cache (owner pubkey +
 * coordinate), which is wiped on logout (`clearOwnerCache`) — so decisions never
 * cross accounts and never linger for the next person. Legacy global localStorage
 * entries are intentionally DROPPED, not migrated: an ownerless entry has no
 * account to attribute it to, and adopting it under whoever is active now is
 * exactly the cross-account inheritance this finding closes.
 */
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

export type ReviewState = "rejected" | "deferred";

export type ReviewMap = Record<string, ReviewState>;

function reviewKey(coordinate: string): string {
  return `review:${coordinate}`;
}

function dismissedKey(coordinate: string): string {
  return `coord-status-dismissed:${coordinate}`;
}

function revokedKey(coordinate: string): string {
  return `revoked-at:${coordinate}`;
}

/**
 * When this organizer revoked each attendee of an event, in seconds (audit R-13).
 * Owner-scoped like the review map. The revoked member's own pre-revocation join
 * request stays on the relays, and once the rotated roster no longer lists them
 * a reload showed it as a NEW request, which Approve or "Approve all" turned
 * straight back into a grant of the rotated key. A join sent AFTER the revoke is
 * a genuine new request and is shown.
 */
export type RevokedAtMap = Record<string, number>;

/** The persisted revoked-at map for an event (empty when none / logged out). */
export function loadRevokedAt(coordinate: string): RevokedAtMap {
  return cacheGet<RevokedAtMap>(revokedKey(coordinate))?.data ?? {};
}

/** Record that `pubkey` was revoked at `at` (seconds); returns the new map. */
export function recordRevokedAt(
  coordinate: string,
  current: RevokedAtMap,
  pubkey: string,
  at: number = Math.floor(Date.now() / 1000),
): RevokedAtMap {
  const next: RevokedAtMap = { ...current, [pubkey]: Math.max(at, current[pubkey] ?? 0) };
  cacheSet(revokedKey(coordinate), next, Math.floor(Date.now() / 1000));
  return next;
}

/** Load the persisted review map for an event (empty when none / logged out). */
export function loadReview(coordinate: string): ReviewMap {
  return cacheGet<ReviewMap>(reviewKey(coordinate))?.data ?? {};
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
  // Owner-scoped (default scope = active owner); wiped on logout. `at = now` so a
  // fresh decision always lands over an older one for the same owner+event.
  cacheSet(reviewKey(coordinate), next, Math.floor(Date.now() / 1000));
  return next;
}

/** Pubkeys in a given review state, as a Set (for the queue filter). */
export function pubkeysInState(map: ReviewMap, state: ReviewState): Set<string> {
  return new Set(Object.entries(map).filter(([, s]) => s === state).map(([pk]) => pk));
}

/** Dismissed coordinator-status ids for an event (owner-scoped; empty when none). */
export function loadDismissedStatuses(coordinate: string): string[] {
  return cacheGet<string[]>(dismissedKey(coordinate))?.data ?? [];
}

/** Persist the dismissed coordinator-status id set for an event (owner-scoped). */
export function saveDismissedStatuses(coordinate: string, ids: string[]): void {
  cacheSet(dismissedKey(coordinate), ids, Math.floor(Date.now() / 1000));
}

/**
 * One-time cleanup of the pre-U11 GLOBAL localStorage entries (review maps keyed
 * by coordinate alone, and the single shared dismissed-status array). Best-effort
 * and safe to call repeatedly; removing them stops a shared device from leaking
 * one organizer's decisions to the next.
 */
export function purgeLegacyGlobalReviewState(): void {
  try {
    if (typeof localStorage === "undefined") return;
    const toDelete: string[] = ["nostrautica-coord-status-dismissed"];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("nostrautica:review:")) toDelete.push(k);
    }
    for (const k of toDelete) localStorage.removeItem(k);
  } catch {
    /* storage unavailable — nothing to purge */
  }
}
