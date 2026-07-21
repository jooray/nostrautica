import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import {
  eventSignerFromKey,
  buildChatKeyProfile,
  resolveChatIdentity,
  loadChatDeviceKey,
  lockChatIdentityForLogout,
  unlockChatIdentityForLogin,
  type ChatIdentity,
} from "./identity.js";
import {
  makeMarmotStores,
  marmotKvBackend,
  InMemoryKvBackend,
  __setMarmotKvBackendForTests,
} from "./stores.js";
import type { AppSigner } from "$lib/signer/types.js";
import {
  signAccountIdentityProof,
  accountIdentityProofSigningDigest,
} from "@internet-privacy/marmot-ts/core";

describe("eventSignerFromKey", () => {
  const sk = generateSecretKey();
  const signer = eventSignerFromKey(sk);

  it("exposes the matching public key", () => {
    expect(signer.getPublicKey()).toBe(getPublicKey(sk));
  });

  it("signs a verifiable event", () => {
    const ev = signer.signEvent({ kind: 1, created_at: 1_700_000_000, tags: [], content: "hi" });
    expect(ev.pubkey).toBe(getPublicKey(sk));
    expect(verifyEvent(ev)).toBe(true);
  });

  it("round-trips nip44 to another party", () => {
    const other = generateSecretKey();
    const otherPk = getPublicKey(other);
    const otherSigner = eventSignerFromKey(other);
    const ct = signer.nip44.encrypt(otherPk, "secret");
    // the counterparty decrypts using our pubkey
    expect(otherSigner.nip44.decrypt(getPublicKey(sk), ct)).toBe("secret");
  });
});

describe("account identity proof signer", () => {
  const sk = generateSecretKey();
  const request = {
    accountIdentity: Uint8Array.from(Buffer.from(getPublicKey(sk), "hex")),
    mlsSignaturePublicKey: new Uint8Array(32).fill(7),
    ciphersuite: 1,
    signatureScheme: 0x0807,
  };

  it("produces a 64-byte BIP-340 signature (schnorr aux-rand → non-deterministic)", () => {
    const proofSigner = (req: Parameters<typeof signAccountIdentityProof>[0]) =>
      signAccountIdentityProof(req, sk);
    const sig = proofSigner(request);
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
  });

  it("derives a stable 32-byte signing digest from the request", () => {
    const d1 = accountIdentityProofSigningDigest(request);
    const d2 = accountIdentityProofSigningDigest({ ...request });
    expect(d1.length).toBe(32);
    expect(Array.from(d1)).toEqual(Array.from(d2)); // digest is deterministic
  });
});

describe("buildChatKeyProfile", () => {
  it("publishes a kind-0 branded as a Nostrautica chat child key, signed by the chat key", () => {
    const sk = generateSecretKey();
    const identity = {
      pubkey: getPublicKey(sk),
      account: "a".repeat(64),
      isAccountKey: false,
      eventSigner: eventSignerFromKey(sk),
      accountProofSigner: (req: Parameters<typeof signAccountIdentityProof>[0]) => signAccountIdentityProof(req, sk),
      clientId: "web-1",
      secretKey: sk,
    } satisfies ChatIdentity;
    const ev = buildChatKeyProfile(identity, "Alice");
    expect(ev.kind).toBe(0);
    expect(ev.pubkey).toBe(getPublicKey(sk));
    expect(verifyEvent(ev)).toBe(true);
    expect(JSON.parse(ev.content).name).toBe("Nostrautica Alice (chat)");
  });

  it("points `about` at the real account's npub, so the key doesn't read as its own person", () => {
    const sk = generateSecretKey();
    const identity = {
      pubkey: getPublicKey(sk),
      account: "a".repeat(64),
      isAccountKey: false,
      eventSigner: eventSignerFromKey(sk),
      accountProofSigner: (req: Parameters<typeof signAccountIdentityProof>[0]) => signAccountIdentityProof(req, sk),
      clientId: "web-1",
      secretKey: sk,
    } satisfies ChatIdentity;
    const about = JSON.parse(buildChatKeyProfile(identity, "Alice").content).about as string;
    expect(about).toContain(npubEncode("a".repeat(64)));
    expect(about.toLowerCase()).toContain("not a person");
  });

  it("falls back to a generic name when the account name is empty", () => {
    const sk = generateSecretKey();
    const identity = {
      pubkey: getPublicKey(sk),
      account: "a".repeat(64),
      isAccountKey: false,
      eventSigner: eventSignerFromKey(sk),
      accountProofSigner: (req: Parameters<typeof signAccountIdentityProof>[0]) => signAccountIdentityProof(req, sk),
      clientId: "web-1",
      secretKey: sk,
    } satisfies ChatIdentity;
    expect(JSON.parse(buildChatKeyProfile(identity, "  ").content).name).toBe("Nostrautica user (chat)");
  });

  it("carries the account's picture through when given", () => {
    const sk = generateSecretKey();
    const identity = {
      pubkey: getPublicKey(sk),
      account: "a".repeat(64),
      isAccountKey: false,
      eventSigner: eventSignerFromKey(sk),
      accountProofSigner: (req: Parameters<typeof signAccountIdentityProof>[0]) => signAccountIdentityProof(req, sk),
      clientId: "web-1",
      secretKey: sk,
    } satisfies ChatIdentity;
    const content = JSON.parse(buildChatKeyProfile(identity, "Alice", "https://example.com/a.png").content);
    expect(content.picture).toBe("https://example.com/a.png");
  });

  it("omits the picture field when none is given", () => {
    const sk = generateSecretKey();
    const identity = {
      pubkey: getPublicKey(sk),
      account: "a".repeat(64),
      isAccountKey: false,
      eventSigner: eventSignerFromKey(sk),
      accountProofSigner: (req: Parameters<typeof signAccountIdentityProof>[0]) => signAccountIdentityProof(req, sk),
      clientId: "web-1",
      secretKey: sk,
    } satisfies ChatIdentity;
    expect(JSON.parse(buildChatKeyProfile(identity, "Alice").content)).not.toHaveProperty("picture");
  });
});

describe("lockChatIdentityForLogout / unlockChatIdentityForLogin (audit UX-6)", () => {
  beforeEach(() => {
    __setMarmotKvBackendForTests(new InMemoryKvBackend());
  });
  afterEach(() => {
    __setMarmotKvBackendForTests(null);
  });

  // Stand-in for the caller's real self-encrypt (NIP-44 to the account's own
  // pubkey) — the crypto itself is proven in packages/protocol; these tests
  // only need something reversible to prove the lock/unlock plumbing.
  const selfEncrypt = async (pt: string) => `enc:${pt}`;
  const selfDecrypt = async (ct: string) => {
    if (!ct.startsWith("enc:")) throw new Error("bad ciphertext");
    return ct.slice(4);
  };

  it("is a no-op when chat was never used on this device", async () => {
    const account = "a".repeat(64);
    await expect(lockChatIdentityForLogout(account, selfEncrypt)).resolves.toBeUndefined();
    await expect(unlockChatIdentityForLogin(account, selfDecrypt)).resolves.toBeUndefined();
  });

  it("round-trips a local-key account's chat state, including binary values", async () => {
    const account = "a".repeat(64);
    const backend = marmotKvBackend();
    const stores = makeMarmotStores(backend, account);
    await stores.groupStateStore.setItem("g1", { epoch: 1 } as never);
    await stores.rewindStore.setItem("g1", new Uint8Array([1, 2, 3]));

    await lockChatIdentityForLogout(account, selfEncrypt);
    // Plaintext is gone once locked.
    expect(await stores.groupStateStore.getItem("g1")).toBeNull();
    expect(await stores.rewindStore.getItem("g1")).toBeNull();

    await unlockChatIdentityForLogin(account, selfDecrypt);
    expect(await stores.groupStateStore.getItem("g1")).toEqual({ epoch: 1 });
    expect(await stores.rewindStore.getItem("g1")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("round-trips a remote-signer account's device key without forking its MLS identity", async () => {
    const account = "b".repeat(64);
    const fakeSigner = { getPublicKey: async () => account } as unknown as AppSigner; // no getSecretKey → device-key path
    const before = await resolveChatIdentity(fakeSigner);
    expect(before.isAccountKey).toBe(false);

    await lockChatIdentityForLogout(account, selfEncrypt);
    expect(await loadChatDeviceKey(account)).toBeUndefined(); // plaintext gone

    await unlockChatIdentityForLogin(account, selfDecrypt);
    const after = await resolveChatIdentity(fakeSigner);
    // Restored the SAME chat identity — not a freshly-minted, forked one.
    expect(after.pubkey).toBe(before.pubkey);
  });

  it("a snapshot that fails to decrypt is left in place for a later retry", async () => {
    const account = "c".repeat(64);
    const backend = marmotKvBackend();
    const stores = makeMarmotStores(backend, account);
    await stores.groupStateStore.setItem("g1", { epoch: 1 } as never);
    await lockChatIdentityForLogout(account, selfEncrypt);

    await unlockChatIdentityForLogin(account, async () => {
      throw new Error("wrong owner");
    });
    expect(await stores.groupStateStore.getItem("g1")).toBeNull(); // not restored

    // The snapshot wasn't consumed — a later login with the right signer works.
    await unlockChatIdentityForLogin(account, selfDecrypt);
    expect(await stores.groupStateStore.getItem("g1")).toEqual({ epoch: 1 });
  });

  it("resolveChatIdentity waits for an in-flight unlock instead of forking the device key", async () => {
    // Reproduces the race a reviewer found: adopt() doesn't block session.loggedIn
    // on the chat-identity unlock finishing (a NIP-46 decrypt round-trips over
    // relays, and +layout.svelte's UX-19 fix runs restore() in the background
    // rather than gate first paint on it) — so a chat prewarm can call
    // resolveChatIdentity WHILE the real device key is still mid-restore. Without
    // the unlockInFlight guard, ensureChatDeviceKey would see "none yet" and mint
    // a fresh one, forking the account's MLS credential.
    const account = "e".repeat(64);
    const fakeSigner = { getPublicKey: async () => account } as unknown as AppSigner;

    const before = await resolveChatIdentity(fakeSigner); // establishes the real device key
    await lockChatIdentityForLogout(account, selfEncrypt);
    expect(await loadChatDeviceKey(account)).toBeUndefined(); // locked away

    // The unlock starts but its decrypt (a NIP-46 round trip in production) is slow.
    let releaseDecrypt!: () => void;
    const gate = new Promise<void>((resolve) => (releaseDecrypt = resolve));
    const slowDecrypt = async (ct: string) => {
      await gate;
      return selfDecrypt(ct);
    };
    const unlockPromise = unlockChatIdentityForLogin(account, slowDecrypt);

    // A chat prewarm races in while the unlock is still pending.
    const resolvePromise = resolveChatIdentity(fakeSigner);

    releaseDecrypt();
    await unlockPromise;
    const after = await resolvePromise;

    expect(after.pubkey).toBe(before.pubkey); // restored — not forked into a new identity
  });

  it("an unlock storage failure doesn't propagate into a concurrent resolveChatIdentity call", async () => {
    // A reviewer flagged: if `unlockChatIdentityForLogin`'s own read throws (a
    // storage error, not just an undecryptable snapshot), the resulting
    // rejection must not crash an unrelated, concurrently-racing
    // resolveChatIdentity — it should just fall through to minting a device
    // key, not throw.
    const account = "f".repeat(64);
    const fakeSigner = { getPublicKey: async () => account } as unknown as AppSigner;
    const inner = new InMemoryKvBackend();
    let failNextLockedGet = false;
    __setMarmotKvBackendForTests({
      get: (k) =>
        failNextLockedGet && k.includes("__chat_locked__")
          ? ((failNextLockedGet = false), Promise.reject(new Error("storage read failure")))
          : inner.get(k),
      set: (k, v) => inner.set(k, v),
      del: (k) => inner.del(k),
      keysWithPrefix: (p) => inner.keysWithPrefix(p),
      clearPrefix: (p) => inner.clearPrefix(p),
    });

    await resolveChatIdentity(fakeSigner); // establishes a device key
    await lockChatIdentityForLogout(account, selfEncrypt);

    failNextLockedGet = true;
    const unlockPromise = unlockChatIdentityForLogin(account, selfDecrypt);
    const resolvePromise = resolveChatIdentity(fakeSigner); // races concurrently

    await expect(unlockPromise).rejects.toThrow(); // the unlock itself still fails…
    await expect(resolvePromise).resolves.toBeDefined(); // …but this caller does not
  });

  it("a record that fails to encrypt is left in plaintext, not lost", async () => {
    const account = "d".repeat(64);
    const stores = makeMarmotStores(marmotKvBackend(), account);
    await stores.groupStateStore.setItem("g1", { epoch: 1 } as never);

    await lockChatIdentityForLogout(account, async () => {
      throw new Error("signer unreachable");
    });
    expect(await stores.groupStateStore.getItem("g1")).toEqual({ epoch: 1 });
  });

  it("locking is scoped to the given account only", async () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const backend = marmotKvBackend();
    await makeMarmotStores(backend, a).groupStateStore.setItem("g1", { epoch: 1 } as never);
    await makeMarmotStores(backend, b).groupStateStore.setItem("g1", { epoch: 2 } as never);

    await lockChatIdentityForLogout(a, selfEncrypt);
    expect(await makeMarmotStores(backend, a).groupStateStore.getItem("g1")).toBeNull();
    expect(await makeMarmotStores(backend, b).groupStateStore.getItem("g1")).toEqual({ epoch: 2 });
  });
});
