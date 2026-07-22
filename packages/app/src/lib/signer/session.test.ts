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
vi.mock("$lib/signer/keystore.js", () => ({
  saveLocalKey: vi.fn(async () => {}),
  loadLocalKey: vi.fn(async () => null),
  loadLoginMethod: vi.fn(async () => null),
  saveLoginMethod: vi.fn(async () => {}),
  saveNip46Session: vi.fn(async () => {}),
  loadNip46Session: vi.fn(async () => null),
  clearKeystore: vi.fn(async () => {}),
}));

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
  unlockEventKeysForLogin: vi.fn(async (_decrypt: (ct: string) => Promise<string>, _owner?: string) => {}),
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
const { recentEventsClear, clearAllJoinSent } = vi.hoisted(() => ({
  recentEventsClear: vi.fn(),
  clearAllJoinSent: vi.fn(),
}));
vi.mock("$lib/stores/recent-events.svelte.js", () => ({
  recentEvents: { clear: recentEventsClear },
}));
vi.mock("$lib/stores/join-sent.svelte.js", () => ({ clearAllJoinSent }));

import { consumeNsecFromHash, session } from "./session.svelte.js";
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
    clearAllJoinSent.mockClear();
  });

  it("does not lock on a logout when nobody is logged in", async () => {
    await session.logout();
    expect(lockEventKeysForLogout).not.toHaveBeenCalled();
    expect(lockChatIdentityForLogout).not.toHaveBeenCalled();
  });

  it("logout clears non-owner-scoped residues (recent events, join-sent markers)", async () => {
    await session.createLocalKey();
    await session.logout();
    expect(recentEventsClear).toHaveBeenCalledTimes(1);
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
    clearAllJoinSent.mockClear();
  });

  it("applyRemoteLogout tears down this tab's owner state for the same identity", async () => {
    await session.createLocalKey();
    const owner = session.pubkey!;
    session.applyRemoteLogout(owner);
    expect(session.loggedIn).toBe(false);
    expect(session.pubkey).toBeNull();
    expect(recentEventsClear).toHaveBeenCalled();
    expect(clearAllJoinSent).toHaveBeenCalled();
  });

  it("ignores a remote logout for a DIFFERENT identity", async () => {
    await session.createLocalKey();
    const other = "f".repeat(64);
    session.applyRemoteLogout(other);
    expect(session.loggedIn).toBe(true); // untouched
  });
});
