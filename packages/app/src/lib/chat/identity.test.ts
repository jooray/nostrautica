import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { eventSignerFromKey, buildChatKeyProfile, type ChatIdentity } from "./identity.js";
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
