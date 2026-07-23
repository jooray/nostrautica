/**
 * Backup nag (UI-SUGGESTIONS #8): local-key users get a gentle, dismissable
 * reminder until they've backed up their key once. "Backed up" is self-reported
 * (an explicit "I saved it"); the point is one honest nudge.
 *
 * Owner-scoped (audit UX-O7 / UX-13): the marker is keyed by the identity's
 * pubkey, so backing up one account no longer silences the nudge for a different
 * account signed in on the same device.
 */
import { session } from "$lib/signer/session.svelte.js";

function keyFor(pubkey: string): string {
  return `nostrautica:backup-done:${pubkey}`;
}

function read(pubkey: string): boolean {
  try {
    return localStorage.getItem(keyFor(pubkey)) === "1";
  } catch {
    return true; // no storage → never nag
  }
}

// Reactive per-owner overlay so a fresh markBackedUp() flips the nag immediately;
// falls back to localStorage for the first read of each identity.
let doneMap = $state<Record<string, boolean>>({});

export const backupNag = {
  get done(): boolean {
    const pk = session.pubkey;
    if (!pk) return true; // no identity → nothing to nag about
    return doneMap[pk] ?? read(pk);
  },
};

export function markBackedUp(): void {
  const pk = session.pubkey;
  if (!pk) return;
  doneMap = { ...doneMap, [pk]: true };
  try {
    localStorage.setItem(keyFor(pk), "1");
  } catch {
    /* private mode */
  }
}
