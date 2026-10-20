/**
 * "I already saved it" on the Home nudge is a dismissal, not a backup (audit
 * DS41-016). The logout guard reads `backupNag.done` to decide whether deleting
 * an app-generated key is safe, so only BackupCard's confirmation may set it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { session } = vi.hoisted(() => ({ session: { pubkey: "a".repeat(64) as string | null } }));
vi.mock("$lib/signer/session.svelte.js", () => ({ session }));

import { backupNag, markBackedUp, dismissBackupNudge } from "./backup-nag.svelte.js";
import { logoutRisk } from "$lib/pages/Me.svelte";

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  } as Storage;
}

let n = 0;
beforeEach(() => {
  // A fresh identity per case: the in-memory overlays are module state.
  session.pubkey = (++n).toString(16).padStart(64, "0");
  vi.stubGlobal("localStorage", memStorage());
});

describe("backup nag (DS41-016)", () => {
  it("dismissing the nudge hides it but leaves the key-loss guard armed", () => {
    expect(backupNag.done).toBe(false);
    expect(backupNag.dismissed).toBe(false);
    dismissBackupNudge();
    expect(backupNag.dismissed).toBe(true);
    expect(backupNag.done).toBe(false);
    expect(logoutRisk({ localKey: true, backedUp: backupNag.done, unsentCount: 0 })).toBe("keyLoss");
  });

  it("only the BackupCard confirmation counts as backed up", () => {
    markBackedUp();
    expect(backupNag.done).toBe(true);
    expect(logoutRisk({ localKey: true, backedUp: backupNag.done, unsentCount: 0 })).toBe("none");
  });

  it("an unreadable marker is not a backup — but does not nag either", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(backupNag.done).toBe(false);
    expect(backupNag.dismissed).toBe(true);
  });
});
