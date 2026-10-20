/**
 * Backup nag (UI-SUGGESTIONS #8): local-key users get a gentle, dismissable
 * reminder until they've backed up their key once.
 *
 * Two different facts, kept apart (audit DS41-016):
 *  - `done` — the user CONFIRMED the backup in BackupCard ("I saved it", reachable
 *    only after the key was copied or exported). This is what the logout guard
 *    trusts before letting `clearKeystore()` delete an app-generated key.
 *  - `dismissed` — the user waved the Home nudge away. It silences the nudge and
 *    nothing else: no key was shown, copied or confirmed, so it must never be
 *    read as "safe to delete the only copy".
 *
 * Owner-scoped (audit UX-O7 / UX-13): both markers are keyed by the identity's
 * pubkey, so backing up one account no longer silences the nudge for a different
 * account signed in on the same device.
 */
import { session } from "$lib/signer/session.svelte.js";

function doneKey(pubkey: string): string {
  return `nostrautica:backup-done:${pubkey}`;
}
function dismissedKey(pubkey: string): string {
  return `nostrautica:backup-nudge-dismissed:${pubkey}`;
}

/** localStorage flag, or `onError` when storage can't be read. */
function readFlag(key: string, onError: boolean): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return onError;
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    /* private mode — the in-memory overlay still holds it for this session */
  }
}

// Reactive per-owner overlays so a fresh mark flips the UI immediately; they
// fall back to localStorage for the first read of each identity.
let doneMap = $state<Record<string, boolean>>({});
let dismissedMap = $state<Record<string, boolean>>({});

export const backupNag = {
  /** The key backup was confirmed. Unreadable storage is NOT a confirmation. */
  get done(): boolean {
    const pk = session.pubkey;
    if (!pk) return true; // no identity → nothing to nag about
    return doneMap[pk] ?? readFlag(doneKey(pk), false);
  },
  /** The Home nudge was dismissed. Unreadable storage → don't nag (as before). */
  get dismissed(): boolean {
    const pk = session.pubkey;
    if (!pk) return true;
    return dismissedMap[pk] ?? readFlag(dismissedKey(pk), true);
  },
};

/** BackupCard's confirmation, after the key was actually copied/exported. */
export function markBackedUp(): void {
  const pk = session.pubkey;
  if (!pk) return;
  doneMap = { ...doneMap, [pk]: true };
  writeFlag(doneKey(pk));
}

/** The Home nudge's secondary button: hide the nudge, claim nothing. */
export function dismissBackupNudge(): void {
  const pk = session.pubkey;
  if (!pk) return;
  dismissedMap = { ...dismissedMap, [pk]: true };
  writeFlag(dismissedKey(pk));
}
