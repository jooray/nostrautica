import { describe, it, expect } from "vitest";
import { logoutRisk } from "./Me.svelte";

/**
 * The guard that stands between a newcomer and permanent account loss.
 *
 * Before this existed, `requestLogout` confirmed ONLY when the outbox happened
 * to be non-empty. `session.logout()` calls `clearKeystore()`, which deletes the
 * raw secret key, so for the majority persona — someone whose key this app
 * generated at an event and who never opened the backup card — one tap on a red
 * button with an empty queue was irreversible and unannounced.
 */
describe("logoutRisk", () => {
  it("warns about key loss for an app-held key the user has not saved", () => {
    expect(logoutRisk({ localKey: true, backedUp: false, unsentCount: 0 })).toBe("keyLoss");
  });

  it("still warns about key loss when there are ALSO unsent items", () => {
    // Ordering picks the headline, not the facts: the key-loss panel renders the
    // unsent count too. Losing a queued follow is annoying; losing the only copy
    // of the key is unrecoverable, so that is the sentence the user must read.
    expect(logoutRisk({ localKey: true, backedUp: false, unsentCount: 3 })).toBe("keyLoss");
  });

  it("drops to the outbox warning once the key is confirmed backed up", () => {
    expect(logoutRisk({ localKey: true, backedUp: true, unsentCount: 2 })).toBe("unsent");
  });

  it("logs a backed-up local key out with no ceremony when nothing is queued", () => {
    expect(logoutRisk({ localKey: true, backedUp: true, unsentCount: 0 })).toBe("none");
  });

  it("never claims key loss for a key held by an external signer", () => {
    // nip07 / nip46 / Amber: logging out here forgets a connection, it does not
    // destroy anything. `backupNag.done` is false for these identities too (the
    // marker is about OUR key), so keying off `backedUp` alone would have nagged
    // every remote-signer user about a key we never held.
    expect(logoutRisk({ localKey: false, backedUp: false, unsentCount: 0 })).toBe("none");
    expect(logoutRisk({ localKey: false, backedUp: false, unsentCount: 1 })).toBe("unsent");
  });
});
