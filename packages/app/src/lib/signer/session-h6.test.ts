/**
 * H-6: a background NIP-46 restore must never overwrite a newer login or undo a
 * logout. Each restore/login/logout captures a monotonic operation token; a slow
 * adoption (the NIP-46 `getPublicKey` round-trip) only applies while its token is
 * still current, and a superseded adoption closes its transport.
 *
 * The NIP-46 signer is mocked with a DEFERRED `getPublicKey` so a competing
 * login/logout can land precisely while a restore is mid-adoption.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface FakeSigner {
  resolve: (pk: string) => void;
  close: ReturnType<typeof vi.fn>;
  signer: {
    getPublicKey: () => Promise<string>;
    close: ReturnType<typeof vi.fn>;
    serialize: () => unknown;
    nip44Encrypt: (p: string, pt: string) => Promise<string>;
    nip44Decrypt: (p: string, ct: string) => Promise<string>;
  };
}

const h = vi.hoisted(() => {
  const signers: FakeSigner[] = [];
  function makeSigner() {
    let resolve!: (pk: string) => void;
    const promise = new Promise<string>((r) => (resolve = r));
    const close = vi.fn(async () => {});
    const signer = {
      getPublicKey: () => promise,
      close,
      serialize: () => ({ tag: "s" }),
      nip44Encrypt: async (_p: string, pt: string) => pt,
      nip44Decrypt: async (_p: string, ct: string) => ct,
    };
    signers.push({ resolve, close, signer });
    return signer;
  }
  return { signers, makeSigner };
});

vi.mock("./nip46.js", () => ({
  Nip46Signer: { fromPersisted: vi.fn(async () => h.makeSigner()) },
  Nip46IdentityMismatchError: class Nip46IdentityMismatchError extends Error {},
}));

vi.mock("./keystore.js", () => ({
  saveLocalKey: vi.fn(async () => {}),
  loadLocalKey: vi.fn(async () => null),
  loadLoginMethod: vi.fn(async () => "nip46"),
  saveLoginMethod: vi.fn(async () => {}),
  saveNip46Session: vi.fn(async () => {}),
  loadNip46Session: vi.fn(async () => ({ tag: "persisted" })),
  clearKeystore: vi.fn(async () => {}),
}));
vi.mock("$lib/events/keystore.js", () => ({
  setActiveOwner: vi.fn(),
  lockEventKeysForLogout: vi.fn(async () => {}),
  unlockEventKeysForLogin: vi.fn(async () => {}),
}));
vi.mock("$lib/chat/identity.js", () => ({
  lockChatIdentityForLogout: vi.fn(async () => {}),
  unlockChatIdentityForLogin: vi.fn(async () => {}),
}));
vi.mock("$lib/stores/recent-events.svelte.js", () => ({ recentEvents: { clear: vi.fn() } }));
vi.mock("$lib/stores/join-sent.svelte.js", () => ({ clearAllJoinSent: vi.fn() }));

import { session } from "./session.svelte.js";

/** Let the restore run up to its pending `getPublicKey` await. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("H-6 session operation token", () => {
  beforeEach(async () => {
    await session.logout().catch(() => {});
    h.signers.length = 0;
  });

  it("adopts a restore that finishes uncontested", async () => {
    const p = session.restore();
    await settle();
    expect(h.signers.length).toBe(1);
    h.signers[0]!.resolve("restored-pk");
    expect(await p).toBe(true);
    expect(session.pubkey).toBe("restored-pk");
    expect(h.signers[0]!.close).not.toHaveBeenCalled();
  });

  it("drops a restore that finishes AFTER a newer login, and closes its transport", async () => {
    const p = session.restore(); // token 1
    await settle();
    // A newer explicit login lands (token 2) and adopts immediately.
    const winner = h.makeSigner(); // signers[1]
    const login = session.loginNip46(winner as never);
    h.signers[1]!.resolve("winner-pk");
    await login;
    expect(session.pubkey).toBe("winner-pk");

    // Now the stale restore's getPublicKey finally resolves — it must be dropped.
    h.signers[0]!.resolve("stale-pk");
    expect(await p).toBe(false);
    expect(session.pubkey).toBe("winner-pk"); // login not clobbered
    expect(h.signers[0]!.close).toHaveBeenCalled(); // superseded transport closed
  });

  it("does not log the user back in when a restore finishes AFTER logout", async () => {
    const p = session.restore(); // token 1
    await settle();
    await session.logout(); // token 2 — supersedes the in-flight restore

    h.signers[0]!.resolve("stale-pk");
    expect(await p).toBe(false);
    expect(session.loggedIn).toBe(false);
    expect(session.pubkey).toBeNull();
    expect(h.signers[0]!.close).toHaveBeenCalled();
  });
});
