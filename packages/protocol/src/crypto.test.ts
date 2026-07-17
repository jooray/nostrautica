import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  generateEck,
  eckEncrypt,
  eckDecrypt,
  nip44Encrypt,
  nip44Decrypt,
  selfEncrypt,
  selfDecrypt,
  blindedD,
  blindedDLiteral,
  aesGcmEncrypt,
  aesGcmDecrypt,
  sha256Hex,
  makeInviteProof,
  verifyInviteProof,
  inviteHash,
  isInviteValid,
  bytesToHex,
} from "./crypto.js";
import { makeCoordinate } from "./coordinate.js";

describe("ECK (outbound symmetric layer)", () => {
  it("round-trips", () => {
    const eck = generateEck();
    const ct = eckEncrypt(eck, "hello directory");
    expect(eckDecrypt(eck, ct)).toBe("hello directory");
  });

  it("fails with the wrong key", () => {
    const ct = eckEncrypt(generateEck(), "secret");
    expect(() => eckDecrypt(generateEck(), ct)).toThrow();
  });

  it("rejects non-32-byte keys", () => {
    expect(() => eckEncrypt(new Uint8Array(16), "x")).toThrow();
  });
});

describe("NIP-44 directed encryption", () => {
  it("round-trips sender → recipient", () => {
    const sender = generateSecretKey();
    const recipient = generateSecretKey();
    const ct = nip44Encrypt(sender, getPublicKey(recipient), "for you");
    expect(nip44Decrypt(recipient, getPublicKey(sender), ct)).toBe("for you");
  });

  it("a third party cannot decrypt", () => {
    const sender = generateSecretKey();
    const recipient = generateSecretKey();
    const attacker = generateSecretKey();
    const ct = nip44Encrypt(sender, getPublicKey(recipient), "for you");
    expect(() =>
      nip44Decrypt(attacker, getPublicKey(sender), ct),
    ).toThrow();
  });
});

describe("NIP-44 self-encryption", () => {
  it("round-trips", () => {
    const sk = generateSecretKey();
    const ct = selfEncrypt(sk, "my private note");
    expect(selfDecrypt(sk, ct)).toBe("my private note");
  });
  it("another key cannot read it", () => {
    const ct = selfEncrypt(generateSecretKey(), "mine");
    expect(() => selfDecrypt(generateSecretKey(), ct)).toThrow();
  });
});

describe("blinded d-tags", () => {
  const coord = makeCoordinate("a".repeat(64), "myevent");
  const attendee = "b".repeat(64);

  it("is deterministic for the same key + inputs", () => {
    const key = generateEck();
    expect(blindedD(key, coord, attendee)).toBe(blindedD(key, coord, attendee));
  });

  it("is 32 hex chars (16 bytes)", () => {
    expect(blindedD(generateEck(), coord, attendee)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("differs across keys, attendees, and coordinates", () => {
    const k1 = generateEck();
    const k2 = generateEck();
    expect(blindedD(k1, coord, attendee)).not.toBe(blindedD(k2, coord, attendee));
    expect(blindedD(k1, coord, attendee)).not.toBe(
      blindedD(k1, coord, "c".repeat(64)),
    );
    expect(blindedD(k1, coord, attendee)).not.toBe(
      blindedD(k1, makeCoordinate("a".repeat(64), "other"), attendee),
    );
  });

  it("library literal is stable and distinct from per-attendee d", () => {
    const key = generateEck();
    expect(blindedDLiteral(key, "library")).toBe(blindedDLiteral(key, "library"));
    expect(blindedDLiteral(key, "library")).not.toBe(blindedD(key, coord, attendee));
  });
});

describe("AES-256-GCM media", () => {
  it("encrypts and decrypts back to the original bytes", async () => {
    const data = crypto.getRandomValues(new Uint8Array(4096));
    const { ciphertext, key, nonce } = await aesGcmEncrypt(data);
    expect(ciphertext).not.toEqual(data);
    const back = await aesGcmDecrypt(ciphertext, key, nonce);
    expect(back).toEqual(data);
  });

  it("fails on a tampered ciphertext (GCM auth)", async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const { ciphertext, key, nonce } = await aesGcmEncrypt(data);
    ciphertext[0]! ^= 0xff;
    await expect(aesGcmDecrypt(ciphertext, key, nonce)).rejects.toBeDefined();
  });

  it("fails with the wrong key", async () => {
    const { ciphertext, nonce } = await aesGcmEncrypt(new Uint8Array([9, 9, 9]));
    const wrong = crypto.getRandomValues(new Uint8Array(32));
    await expect(aesGcmDecrypt(ciphertext, wrong, nonce)).rejects.toBeDefined();
  });

  it("sha256Hex is stable", () => {
    expect(sha256Hex(new Uint8Array([0]))).toBe(
      "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
    );
  });
});

describe("invite proofs (spec §6.5)", () => {
  const coord = makeCoordinate("a".repeat(64), "cypherpunk");
  const attendee = getPublicKey(generateSecretKey());

  it("verifies a valid proof", () => {
    const invite = generateSecretKey();
    const proof = makeInviteProof(invite, coord, attendee);
    expect(verifyInviteProof(proof, coord, attendee)).toBe(true);
  });

  it("binds the proof to the attendee pubkey (replay against another attendee fails)", () => {
    const invite = generateSecretKey();
    const proof = makeInviteProof(invite, coord, attendee);
    const otherAttendee = getPublicKey(generateSecretKey());
    expect(verifyInviteProof(proof, coord, otherAttendee)).toBe(false);
  });

  it("is bound to the coordinate", () => {
    const invite = generateSecretKey();
    const proof = makeInviteProof(invite, coord, attendee);
    const otherCoord = makeCoordinate("a".repeat(64), "other");
    expect(verifyInviteProof(proof, otherCoord, attendee)).toBe(false);
  });

  it("stateless verification against the published hash set", () => {
    const invite = generateSecretKey();
    const proof = makeInviteProof(invite, coord, attendee);
    const published = new Set([inviteHash(getPublicKey(invite))]);
    expect(isInviteValid(proof, published, coord, attendee)).toBe(true);
    // Unknown invite pubkey (not in published set) is rejected even if sig is valid.
    expect(isInviteValid(proof, new Set(), coord, attendee)).toBe(false);
  });

  it("rejects a forged signature", () => {
    const invite = generateSecretKey();
    const proof = makeInviteProof(invite, coord, attendee);
    const tampered = { ...proof, sig: bytesToHex(new Uint8Array(64)) };
    expect(verifyInviteProof(tampered, coord, attendee)).toBe(false);
  });
});
