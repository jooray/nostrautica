/**
 * `#/login?nsec=…` cleanup (audit UX-12): the secret is stripped from the URL,
 * history, AND the router's in-memory route — otherwise navigating away pushes
 * the nsec-carrying route onto the router stack and in-app Back rebuilds it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { nsecEncode } from "nostr-tools/nip19";

// The signer keystore is IndexedDB-backed (absent in the test env) — mock it;
// UX-12 is about URL/route handling, not persistence.
const keystore = vi.hoisted(() => ({
  saveLocalKey: vi.fn(async (_sk?: unknown) => {}),
  loadLocalKey: vi.fn(async () => null as Uint8Array | null),
  loadLoginMethod: vi.fn(async () => null as string | null),
  saveLoginMethod: vi.fn(async (_m?: unknown) => {}),
  saveNip46Session: vi.fn(async (_s?: unknown) => {}),
  loadNip46Session: vi.fn(async () => null as unknown),
  clearKeystore: vi.fn(async () => {}),
}));
vi.mock("$lib/signer/keystore.js", () => keystore);

// The event-key store is also IndexedDB-backed. `setActiveOwner` is a harmless
// no-op to mock; the lock/unlock calls (audit UX-6) are spied on directly so
// the wiring tests below can assert on them without touching real storage.
const { lockEventKeysForLogout, unlockEventKeysForLogin } = vi.hoisted(() => ({
  lockEventKeysForLogout: vi.fn(
    async (
      _encrypt: (pt: string) => Promise<string>,
      _decrypt: (ct: string) => Promise<string>,
      _owner?: string,
    ) => {},
  ),
  unlockEventKeysForLogin: vi.fn(async (_decrypt: (ct: string) => Promise<string>, _owner?: string) => true),
}));
vi.mock("$lib/events/keystore.js", () => ({
  setActiveOwner: vi.fn(),
  lockEventKeysForLogout,
  unlockEventKeysForLogin,
}));

// Same for the chat/MLS lock (audit UX-6, chat half) — also IndexedDB-backed.
const { lockChatIdentityForLogout, unlockChatIdentityForLogin } = vi.hoisted(() => ({
  lockChatIdentityForLogout: vi.fn(async (_account: string, _encrypt: (pt: string) => Promise<string>) => {}),
  unlockChatIdentityForLogin: vi.fn(async (_account: string, _decrypt: (ct: string) => Promise<string>) => {}),
}));
vi.mock("$lib/chat/identity.js", () => ({
  lockChatIdentityForLogout,
  unlockChatIdentityForLogin,
}));

// Not-owner-scoped localStorage residues (audit UX-6) — spied on so the wiring
// test can assert logout() actually clears them.
const {
  recentEventsClear,
  recentEventsSetOwner,
  recentEventsAwaitIdentity,
  recentEventsIdentitySettled,
  clearAllJoinSent,
  setJoinSentOwner,
} = vi.hoisted(() => ({
  recentEventsClear: vi.fn(),
  recentEventsSetOwner: vi.fn(),
  recentEventsAwaitIdentity: vi.fn(),
  recentEventsIdentitySettled: vi.fn(),
  clearAllJoinSent: vi.fn(),
  setJoinSentOwner: vi.fn(),
}));
vi.mock("$lib/stores/recent-events.svelte.js", () => ({
  recentEvents: {
    clear: recentEventsClear,
    setOwner: recentEventsSetOwner,
    awaitIdentity: recentEventsAwaitIdentity,
    identitySettled: recentEventsIdentitySettled,
  },
}));
vi.mock("$lib/stores/join-sent.svelte.js", () => ({ clearAllJoinSent, setJoinSentOwner }));

import { consumeNsecFromHash, session } from "./session.svelte.js";
import { Nip46Signer, Nip46IdentityMismatchError } from "./nip46.js";
import { router } from "$lib/router/router.svelte.js";
import { buildHash } from "$lib/router/routes.js";

describe("consumeNsecFromHash (audit UX-12)", () => {
  const nsec = nsecEncode(generateSecretKey());
  let replaceState: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { hash: `#/login?nsec=${nsec}` },
      history: { replaceState },
    });
    // The router parsed the deep link, secret and all.
    router.route = { name: "login", nsec };
    await session.logout().catch(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strips the nsec from URL, history, AND the in-memory route", async () => {
    expect(await consumeNsecFromHash()).toBe(true);
    expect(session.loggedIn).toBe(true);

    // URL + history cleaned…
    expect(replaceState).toHaveBeenCalledWith(null, "", "#/login");
    // …and the in-memory route no longer carries the secret, so anything
    // rebuilding a URL from it (the router stack's Back) stays clean.
    expect(router.route).toEqual({ name: "login", nsec: undefined });
    expect(buildHash(router.route)).toBe("#/login");
  });

  it("strips even when the import itself fails", async () => {
    await session.logout().catch(() => {});
    vi.stubGlobal("window", {
      location: { hash: "#/login?nsec=not-a-valid-nsec" },
      history: { replaceState },
    });
    router.route = { name: "login", nsec: "not-a-valid-nsec" };

    await expect(consumeNsecFromHash()).rejects.toThrow();
    expect(router.route.nsec).toBeUndefined();
  });

  it("returns false when the hash carries no nsec", async () => {
    vi.stubGlobal("window", {
      location: { hash: "#/login" },
      history: { replaceState },
    });
    expect(await consumeNsecFromHash()).toBe(false);
  });
});

describe("event-key lock/unlock wiring (audit UX-6)", () => {
  beforeEach(async () => {
    await session.logout().catch(() => {});
    lockEventKeysForLogout.mockClear();
    unlockEventKeysForLogin.mockClear();
    lockChatIdentityForLogout.mockClear();
    unlockChatIdentityForLogin.mockClear();
    recentEventsClear.mockClear();
    recentEventsSetOwner.mockClear();
    clearAllJoinSent.mockClear();
  });

  it("does not lock on a logout when nobody is logged in", async () => {
    await session.logout();
    expect(lockEventKeysForLogout).not.toHaveBeenCalled();
    expect(lockChatIdentityForLogout).not.toHaveBeenCalled();
  });

  it("logout hides owner-scoped recent events and clears join-sent markers", async () => {
    await session.createLocalKey();
    await session.logout();
    expect(recentEventsSetOwner).toHaveBeenLastCalledWith(null);
    expect(clearAllJoinSent).toHaveBeenCalledTimes(1);
  });

  it("login unlocks, logout locks — both scoped to the same pubkey", async () => {
    await session.createLocalKey();
    const pubkey = session.pubkey!;
    expect(unlockEventKeysForLogin).toHaveBeenCalledTimes(1);
    expect(unlockEventKeysForLogin.mock.calls[0]![1]).toBe(pubkey);
    expect(unlockChatIdentityForLogin).toHaveBeenCalledTimes(1);
    expect(unlockChatIdentityForLogin.mock.calls[0]![0]).toBe(pubkey);

    await session.logout();
    expect(lockEventKeysForLogout).toHaveBeenCalledTimes(1);
    expect(lockEventKeysForLogout.mock.calls[0]![2]).toBe(pubkey); // owner is now the 3rd arg (decrypt added)
    expect(lockChatIdentityForLogout).toHaveBeenCalledTimes(1);
    expect(lockChatIdentityForLogout.mock.calls[0]![0]).toBe(pubkey);
    expect(session.loggedIn).toBe(false);
  });

  it("the event-key lock callback self-encrypts with the logged-out identity's own key", async () => {
    await session.createLocalKey();
    await session.logout();
    const encrypt = lockEventKeysForLogout.mock.calls[0]![0] as (pt: string) => Promise<string>;
    const ciphertext = await encrypt("hello");
    expect(typeof ciphertext).toBe("string");
    expect(ciphertext).not.toBe("hello");
  });

  it("the chat-identity lock callback self-encrypts with the logged-out identity's own key", async () => {
    await session.createLocalKey();
    await session.logout();
    const encrypt = lockChatIdentityForLogout.mock.calls[0]![1] as (pt: string) => Promise<string>;
    const ciphertext = await encrypt("hello");
    expect(typeof ciphertext).toBe("string");
    expect(ciphertext).not.toBe("hello");
  });

  it("unlock runs and settles before adopt() returns (no race with a chat prewarm)", async () => {
    // unlockChatIdentityForLogin resolving AFTER createLocalKey() returns would
    // let a caller's `resolveChatIdentity` run first and mint a throwaway
    // device key — awaited-in-adopt() is what rules that out structurally.
    let resolved = false;
    unlockChatIdentityForLogin.mockImplementationOnce(async () => {
      resolved = true;
    });
    await session.createLocalKey();
    expect(resolved).toBe(true);
  });

  it("does not publish the reactive identity before event custody unlock settles", async () => {
    let finish!: () => void;
    unlockEventKeysForLogin.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (finish = () => resolve(true))),
    );
    const login = session.createLocalKey();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.pubkey).toBeNull();
    expect(session.signer).toBeNull();
    expect(session.custodyReady).toBe(false);

    finish();
    await login;
    expect(session.loggedIn).toBe(true);
    expect(session.custodyReady).toBe(true);
  });
});

describe("logout self-encrypt failure surfacing (H-5)", () => {
  beforeEach(async () => {
    await session.logout().catch(() => {});
    lockEventKeysForLogout.mockReset();
    lockEventKeysForLogout.mockResolvedValue(undefined);
    lockChatIdentityForLogout.mockReset();
    lockChatIdentityForLogout.mockResolvedValue(undefined);
  });

  it("sets logoutError when key custody cannot be self-encrypted", async () => {
    await session.createLocalKey();
    lockEventKeysForLogout.mockRejectedValueOnce(new Error("signer unreachable"));
    await session.logout();
    expect(session.logoutError).toBe(true);
  });

  it("leaves logoutError false on a clean logout, and a fresh login clears a stale one", async () => {
    await session.createLocalKey();
    await session.logout();
    expect(session.logoutError).toBe(false);

    // A prior failed logout left the flag set; logging in clears it.
    session.logoutError = true;
    await session.createLocalKey();
    expect(session.logoutError).toBe(false);
  });
});

describe("cross-tab remote logout (H-5)", () => {
  beforeEach(async () => {
    await session.logout().catch(() => {});
    recentEventsClear.mockClear();
    recentEventsSetOwner.mockClear();
    clearAllJoinSent.mockClear();
  });

  it("applyRemoteLogout tears down this tab's owner state for the same identity", async () => {
    await session.createLocalKey();
    const owner = session.pubkey!;
    session.applyRemoteLogout(owner);
    expect(session.loggedIn).toBe(false);
    expect(session.pubkey).toBeNull();
    expect(recentEventsSetOwner).toHaveBeenLastCalledWith(null);
    expect(clearAllJoinSent).toHaveBeenCalled();
  });

  it("ignores a remote logout for a DIFFERENT identity", async () => {
    await session.createLocalKey();
    const other = "f".repeat(64);
    session.applyRemoteLogout(other);
    expect(session.loggedIn).toBe(true); // untouched
  });
});

/**
 * Logout must not be hostage to an unreachable signer (2026-09-04).
 *
 * Each custody-lock step is an encrypt through the active signer, and for NIP-46
 * that is `rpcWithForegroundRetry`: 60 s, or ~132 s if a visibility flip hits
 * the retry path. Two serially is up to ~4.4 minutes with the UI still showing a
 * live session — on a shared device, where a logout that appears not to work is
 * the worst possible failure, because the natural response is to hand the phone
 * over anyway.
 */
describe("logout is bounded even behind a dead signer (2026-09-04)", () => {
  beforeEach(async () => {
    await session.logout().catch(() => {});
    lockEventKeysForLogout.mockReset();
    lockEventKeysForLogout.mockResolvedValue(undefined);
    lockChatIdentityForLogout.mockReset();
    lockChatIdentityForLogout.mockResolvedValue(undefined);
  });

  it("completes the local teardown when both lock steps hang forever", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      await session.createLocalKey();
      expect(session.loggedIn).toBe(true);
      lockEventKeysForLogout.mockReturnValue(new Promise(() => {}));
      lockChatIdentityForLogout.mockReturnValue(new Promise(() => {}));

      const done = session.logout();
      // Both budgets, plus slack. Without them this never settles.
      await vi.advanceTimersByTimeAsync(30_000);
      await done;

      expect(session.loggedIn).toBe(false);
      expect(session.pubkey).toBeNull();
      // …and the user is told the on-device wipe was partial.
      expect(session.logoutError).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes no longer than the two budgets, not the signer's own 60s+ deadlines", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      await session.createLocalKey();
      lockEventKeysForLogout.mockReturnValue(new Promise(() => {}));
      lockChatIdentityForLogout.mockReturnValue(new Promise(() => {}));
      let settled = false;
      void session.logout().then(() => (settled = true));

      // A minute in, the OLD code was still inside the first encrypt.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a lock step that answers in time still runs normally", async () => {
    await session.createLocalKey();
    await session.logout();
    expect(lockEventKeysForLogout).toHaveBeenCalledTimes(1);
    expect(lockChatIdentityForLogout).toHaveBeenCalledTimes(1);
    expect(session.logoutError).toBe(false);
  });
});

/**
 * A failed restore used to be `return false` — no log, no state, no retry. The
 * user landed on the sign-in CTA as though they had never logged in, and the
 * only visible way forward was a fresh QR pairing: a new client key, a new
 * approval in the signer, and the perfectly good persisted session thrown away
 * over what is usually one slow relay.
 */
describe("a failed session restore is visible and retryable", () => {
  // The whole point of the fix is that these paths now LOG; keep the suite output
  // readable while still asserting the behaviour they log about.
  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await session.logout().catch(() => {});
    keystore.loadLoginMethod.mockReset();
    keystore.loadNip46Session.mockReset();
    keystore.clearKeystore.mockClear(); // logout() above calls it
  });

  it("surfaces a retryable state instead of silently landing on the login CTA", async () => {
    keystore.loadLoginMethod.mockResolvedValue("nip46");
    keystore.loadNip46Session.mockResolvedValue({
      clientSkHex: "11".repeat(32),
      bunker: { pubkey: "ab".repeat(32), relays: ["wss://relay.example"] },
    });
    const fromPersisted = vi
      .spyOn(Nip46Signer, "fromPersisted")
      .mockRejectedValue(new Error("Your signer didn't respond"));
    try {
      expect(await session.restore()).toBe(false);
      expect(session.loggedIn).toBe(false);
      expect(session.restoreError).toBe(true);
      expect(session.restoreErrorMessage).toMatch(/didn't respond/);
      // The persisted session is deliberately KEPT, which is what makes the
      // retry meaningful rather than a second doomed attempt.
      expect(keystore.clearKeystore).not.toHaveBeenCalled();
    } finally {
      fromPersisted.mockRestore();
    }
  });

  it("previews cached event cards before a bunker answers and keeps them through a transient failure", async () => {
    const pubkey = "cd".repeat(32);
    keystore.loadLoginMethod.mockResolvedValue("nip46");
    keystore.loadNip46Session.mockResolvedValue({ userPubkey: pubkey });
    let fail!: (error: Error) => void;
    const fromPersisted = vi.spyOn(Nip46Signer, "fromPersisted").mockImplementation(
      () => new Promise((_resolve, reject) => { fail = reject; }),
    );
    recentEventsAwaitIdentity.mockClear();
    recentEventsIdentitySettled.mockClear();
    try {
      const restoring = session.restore();
      await vi.waitFor(() => expect(recentEventsAwaitIdentity).toHaveBeenCalledWith(pubkey));
      expect(session.loggedIn).toBe(false);
      expect(session.pubkey).toBeNull();
      expect(session.restoring).toBe(true);
      fail(new Error("signer offline"));
      expect(await restoring).toBe(false);
      expect(recentEventsIdentitySettled).not.toHaveBeenCalled();
      expect(session.restoreError).toBe(true);
    } finally {
      fromPersisted.mockRestore();
    }
  });

  it("retryRestore re-attempts the SAME persisted session and can succeed", async () => {
    keystore.loadLoginMethod.mockResolvedValue("nip46");
    keystore.loadNip46Session.mockResolvedValue({
      clientSkHex: "11".repeat(32),
      bunker: { pubkey: "ab".repeat(32), relays: ["wss://relay.example"] },
    });
    const pubkey = "cd".repeat(32);
    const fromPersisted = vi
      .spyOn(Nip46Signer, "fromPersisted")
      .mockRejectedValueOnce(new Error("relay hiccup"))
      .mockResolvedValueOnce({
        method: "nip46",
        getPublicKey: async () => pubkey,
        signEvent: async () => ({}),
        nip44Encrypt: async () => "",
        nip44Decrypt: async () => "",
        serialize: () => ({ clientSkHex: "", bunker: { pubkey: "", relays: [] } }),
        close: async () => {},
      } as unknown as Nip46Signer);
    try {
      expect(await session.restore()).toBe(false);
      expect(session.restoreError).toBe(true);

      expect(await session.retryRestore()).toBe(true);
      expect(session.loggedIn).toBe(true);
      expect(session.restoreError).toBe(false); // the banner clears itself
    } finally {
      fromPersisted.mockRestore();
      await session.logout().catch(() => {});
    }
  });

  it("clears the persisted session — and does NOT offer a retry — on an identity mismatch", async () => {
    keystore.loadLoginMethod.mockResolvedValue("nip46");
    keystore.loadNip46Session.mockResolvedValue({
      clientSkHex: "11".repeat(32),
      bunker: { pubkey: "ab".repeat(32), relays: ["wss://relay.example"] },
    });
    const fromPersisted = vi
      .spyOn(Nip46Signer, "fromPersisted")
      .mockRejectedValue(new Nip46IdentityMismatchError());
    try {
      expect(await session.restore()).toBe(false);
      // A bunker answering for a different user is invalid for good: retrying it
      // could only reproduce the mismatch.
      expect(session.restoreError).toBe(false);
      expect(keystore.clearKeystore).toHaveBeenCalled();
    } finally {
      fromPersisted.mockRestore();
    }
  });
});

/**
 * `adopt()` overwrote `this.signer` without closing what it replaced. For NIP-46
 * that orphan keeps a SimplePool with `enableReconnect` + `enablePing` alive:
 * it re-opens sockets to the signer relays and pings them for the page's
 * lifetime, and the bearer capability it holds stays usable. Reachable without
 * any logout — an imported nsec, a second bunker paste, or an `#/login?nsec=`
 * deep link opened while already signed in.
 */
describe("adopting a new signer closes the one it replaces", () => {
  beforeEach(async () => {
    await session.logout().catch(() => {});
  });

  it("closes the previous signer's transport on an account switch", async () => {
    await session.createLocalKey();
    const close = vi.fn(async () => {});
    // Stand in for the live NIP-46 signer this device was already using.
    (session as unknown as { signer: unknown }).signer = {
      method: "nip46",
      getPublicKey: async () => session.pubkey!,
      signEvent: async () => ({}),
      nip44Encrypt: async () => "",
      nip44Decrypt: async () => "",
      close,
    };

    await session.createLocalKey(); // a different identity signs in
    expect(close).toHaveBeenCalledTimes(1);
  });
});

/**
 * A NIP-07 user whose extension isn't injected must not be silently logged out
 * (2026-09-09 audit, INFRA-N-3).
 *
 * `restore()` guarded the whole branch on `hasNip07()` and fell through to
 * `return false` with no error set. The shell then rendered a logged-OUT app to
 * someone whose key is sitting in the extension, and the sign-in flow's most
 * prominent path creates a NEW local identity — which is how a person ends up
 * with two accounts and no idea why.
 */
describe("a NIP-07 restore with no extension says so", () => {
  beforeEach(async () => {
    await session.logout().catch(() => {});
    keystore.clearKeystore.mockClear(); // the logout above legitimately calls it
    keystore.loadLoginMethod.mockResolvedValue("nip07");
    vi.stubGlobal("window", {});
  });
  afterEach(() => {
    keystore.loadLoginMethod.mockResolvedValue(null);
    vi.unstubAllGlobals();
  });

  it("sets restoreError with the extension kind, and keeps the persisted method for a retry", async () => {
    expect(await session.restore()).toBe(false);
    expect(session.loggedIn).toBe(false);
    expect(session.restoreError).toBe(true);
    expect(session.restoreErrorKind).toBe("extension");
    // The method stays on disk — Retry is meant to work once the extension wakes.
    expect(keystore.clearKeystore).not.toHaveBeenCalled();
  });

  it("restores silently, with no error, once the extension IS present", async () => {
    const pubkey = "a".repeat(64);
    vi.stubGlobal("window", { nostr: { getPublicKey: async () => pubkey } });
    expect(await session.restore()).toBe(true);
    expect(session.restoreError).toBe(false);
    expect(session.restoreErrorKind).toBeNull();
  });
});
