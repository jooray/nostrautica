/**
 * Backup nag (UI-SUGGESTIONS #8): local-key users get a gentle, dismissable
 * reminder on Home until they've backed up their key once. "Backed up" is
 * self-reported (any BackupCard action, or an explicit "I saved it") — no
 * verification ceremony, the point is one honest nudge.
 */
const KEY = "nostrautica:backup-done";

function read() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return true; // no storage → never nag
  }
}

let done = $state(typeof localStorage === "undefined" ? true : read());

export const backupNag = {
  get done() {
    return done;
  },
};

export function markBackedUp() {
  done = true;
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* private mode */
  }
}
