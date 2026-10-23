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
 *
 * Keyed by OWNER as well as coordinate. The code is a single-use nsec that
 * auto-approves whoever redeems it, and keying it by coordinate alone meant an
 * account switch in the same tab handed A's unredeemed invite to B, who would
 * then join on it. Scoping the key also avoids clearing a code the same user is
 * mid-flow on, which a wipe-on-switch would.
 */
const PREFIX = "nostrautica:invite:";
const ANON = `${PREFIX}anon:`;

function key(coordinate: string, owner: string | null): string {
  return `${PREFIX}${owner ?? "anon"}:${coordinate}`;
}

/** Every invite key currently in this tab's sessionStorage. */
function inviteKeys(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < (sessionStorage.length ?? 0); i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(PREFIX)) out.push(k);
    }
  } catch {
    /* storage unavailable: nothing persisted to find */
  }
  return out;
}

let inviteOwner: string | null = null;

/**
 * Point invite storage at `pubkey` (or nothing, when signed out).
 *
 * A code stored while SIGNED OUT (Join stashes it before the joiner has an
 * identity) belongs to whoever signs in next in this tab, mid-join: move it
 * under that owner (audit R-26). Left in the shared `anon` slot it was never
 * cleared — Join's clear ran after the owner changed, against a key that was
 * never written — and the next signed-out Join in the tab picked it up and
 * redeemed someone else's single-use invite.
 */
export function setInviteOwner(pubkey: string | null): void {
  inviteOwner = pubkey;
  if (!pubkey) return;
  for (const k of inviteKeys()) {
    if (!k.startsWith(ANON)) continue;
    try {
      const target = key(k.slice(ANON.length), pubkey);
      const v = sessionStorage.getItem(k);
      if (v && sessionStorage.getItem(target) === null) sessionStorage.setItem(target, v);
      sessionStorage.removeItem(k);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Drop every stashed invite in this tab, for every owner (logout, remote
 * logout). The code must not outlive the session that was using it (R-26).
 */
export function purgeInvites(): void {
  for (const k of inviteKeys()) {
    try {
      sessionStorage.removeItem(k);
    } catch {
      /* nothing to clear */
    }
  }
}

/** Persist the invite code for this event (best-effort; private mode → no-op). */
export function storeInvite(coordinate: string, nsec: string): void {
  try {
    sessionStorage.setItem(key(coordinate, inviteOwner), nsec);
  } catch {
    /* storage unavailable — the code just lives in memory for this page */
  }
}

/** The persisted invite code for this event, or undefined. */
export function loadInvite(coordinate: string): string | undefined {
  try {
    return sessionStorage.getItem(key(coordinate, inviteOwner)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Drop the persisted invite code (after confirmed submission or cancel). */
export function clearInvite(coordinate: string): void {
  try {
    sessionStorage.removeItem(key(coordinate, inviteOwner));
    // …and the signed-out slot, in case it was stored there and nothing has
    // re-owned it yet (R-26).
    sessionStorage.removeItem(key(coordinate, null));
  } catch {
    /* nothing to clear */
  }
}
