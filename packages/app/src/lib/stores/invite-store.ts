/**
 * Invite-code persistence across a reload / signer round-trip (audit UX-O2).
 *
 * The invite code is a single-use nsec that rides the URL fragment; Join strips
 * it from the URL immediately (correct — it must never sit in history). But
 * keeping it ONLY in component memory means a mobile signer handoff, a process
 * eviction, or an accidental reload silently downgrades an invited join to a
 * manual-approval one. We stash it in `sessionStorage`, keyed by event
 * coordinate, so it survives those round-trips within the tab session, and clear
 * it once the join is confirmed queued/published or explicitly cancelled.
 *
 * sessionStorage (not localStorage): scoped to the tab, gone when the tab
 * closes — the code should not outlive the session that's using it.
 */
function key(coordinate: string): string {
  return `nostrautica:invite:${coordinate}`;
}

/** Persist the invite code for this event (best-effort; private mode → no-op). */
export function storeInvite(coordinate: string, nsec: string): void {
  try {
    sessionStorage.setItem(key(coordinate), nsec);
  } catch {
    /* storage unavailable — the code just lives in memory for this page */
  }
}

/** The persisted invite code for this event, or undefined. */
export function loadInvite(coordinate: string): string | undefined {
  try {
    return sessionStorage.getItem(key(coordinate)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Drop the persisted invite code (after confirmed submission or cancel). */
export function clearInvite(coordinate: string): void {
  try {
    sessionStorage.removeItem(key(coordinate));
  } catch {
    /* nothing to clear */
  }
}
