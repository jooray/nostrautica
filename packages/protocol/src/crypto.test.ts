import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { utf8ToBytes } from "@noble/hashes/utils";
import {
  generateEck,
  eckEncrypt,
  eckDecrypt,
  nip44Encrypt,
  nip44Decrypt,
  selfEncrypt,
  selfDecrypt,
  isNip44Ciphertext,
  isNip04Ciphertext,
  blindedD,
  blindedDLiteral,
  collidesWithBlindedDMessage,
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

/**
 * blinded-d domain separation.
 *
 * `blindedD` and `blindedDLiteral` share ONE HMAC key and neither prefixes a
 * tag, so the only thing keeping their message spaces apart is the SHAPE of the
 * strings each is called with — `<kind>:<hex64>:<d>|<hex64>` for the former,
 * a word-initial literal for the latter. That is a real separation but an
 * accidental one, and the textbook fix (a distinct constant tag per function) is
 * deliberately not applied: the derived value IS the published `d` of every
 * 31602/31603/31605/31610 record, so re-deriving it makes every live event's
 * directory entries, match lists, reuse library and talks unaddressable — a
 * wire-visible break of a frozen format to close a collision no caller can reach.
 *
 * These tests are the substitute: they pin the current inputs as non-overlapping,
 * so a future literal that happens to look like a coordinate fails loudly here
 * rather than silently addressing another record's `d`.
 */
describe("blinded-d domain separation", () => {
  const coord = makeCoordinate("a".repeat(64), "myevent");
  const attendee = "b".repeat(64);

  /** Every literal `blindedDLiteral` is called with anywhere in the codebase. */
  const LITERALS = [
    "library", // media/submit.ts — the cross-event reuse library entry
    "chat-device-key", // chat/legacy-cleanup.ts — the legacy device-key entry
    `talk|${coord}|${attendee}|talk-1`, // nostr/publisher.ts — per-talk blinded d
  ];

  it("no literal in use is shaped like a blindedD message", () => {
    for (const literal of LITERALS) {
      expect(collidesWithBlindedDMessage(literal)).toBe(false);
    }
    // The shape rule itself is right: a real blindedD message DOES match, so the
    // guard above is not vacuously true.
    expect(collidesWithBlindedDMessage(`${coord}|${attendee}`)).toBe(true);
    // And the trap it exists to catch — a "literal" that is really a coordinate.
    expect(collidesWithBlindedDMessage(`31923:${"a".repeat(64)}:ev|${attendee}`)).toBe(true);
  });

  it("no literal in use collides with a per-attendee blinded d under the same key", () => {
    // The empirical half: derive both families under one key and assert the
    // outputs are disjoint. `talk|…` embeds a coordinate and a pubkey, which is
    // exactly the near-miss worth pinning.
    const key = generateEck();
    const literalDs = LITERALS.map((l) => blindedDLiteral(key, l));
    const coordinateDs = [
      blindedD(key, coord, attendee),
      blindedD(key, coord, "c".repeat(64)),
      blindedD(key, makeCoordinate("a".repeat(64), "other"), attendee),
    ];
    for (const l of literalDs) expect(coordinateDs).not.toContain(l);
    expect(new Set([...literalDs, ...coordinateDs]).size).toBe(
      literalDs.length + coordinateDs.length,
    );
  });

  it("a literal that IS a coordinate message derives the same d — which is why the shape rule is pinned", () => {
    // The collision is genuinely reachable if a caller ever passes a
    // coordinate-shaped literal: same key, same message, same HMAC, same `d`.
    // Nothing in the derivation prevents it; only the test above does.
    const key = generateEck();
    expect(blindedDLiteral(key, `${coord}|${attendee}`)).toBe(blindedD(key, coord, attendee));
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

describe("invite proofs (NIP §7, v2 challenge)", () => {
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

  it("rejects a v1-format proof (flag day: v1 challenge no longer verifies)", () => {
    // Reconstruct the v1 challenge (bare `sha256("<coordinate>:<attendee>")`) and
    // sign it with a real invite key — this is exactly what a v1 client produced.
    // Under the v2 domain-separated/injective challenge it MUST fail verification.
    const invite = generateSecretKey();
    const invitePubkey = getPublicKey(invite);
    const v1Digest = sha256(utf8ToBytes(`${coord}:${attendee}`));
    const v1Proof = { invitePubkey, sig: bytesToHex(schnorr.sign(v1Digest, invite)) };
    expect(verifyInviteProof(v1Proof, coord, attendee)).toBe(false);
    const published = new Set([inviteHash(invitePubkey)]);
    expect(isInviteValid(v1Proof, published, coord, attendee)).toBe(false);
    // Sanity: a v2 proof by the same key over the same pair DOES verify.
    const v2Proof = makeInviteProof(invite, coord, attendee);
    expect(isInviteValid(v2Proof, published, coord, attendee)).toBe(true);
  });

  it("isInviteValid returns false (never throws) on malformed proof fields (PROTO-1)", () => {
    const published = new Set<string>();
    // Non-hex / uppercase / wrong-length invite pubkey — inviteHash's hexToBytes
    // would have thrown on these before the fix.
    expect(isInviteValid({ invitePubkey: "nothex", sig: "ab".repeat(64) }, published, coord, attendee)).toBe(false);
    expect(isInviteValid({ invitePubkey: "A".repeat(64), sig: "ab".repeat(64) }, published, coord, attendee)).toBe(false);
    expect(isInviteValid({ invitePubkey: "a".repeat(63), sig: "ab".repeat(64) }, published, coord, attendee)).toBe(false);
    // Malformed signature (non-hex / wrong length).
    expect(isInviteValid({ invitePubkey: "a".repeat(64), sig: "nothex" }, published, coord, attendee)).toBe(false);
    expect(isInviteValid({ invitePubkey: "a".repeat(64), sig: "ab" }, published, coord, attendee)).toBe(false);
    expect(() =>
      isInviteValid({ invitePubkey: "nothex", sig: "zz" }, published, coord, attendee),
    ).not.toThrow();
  });
});

describe("NIP-44 plaintext ceiling (65,535 bytes, PROTO-3)", () => {
  const tooBig = "x".repeat(65_536); // 65,536 UTF-8 bytes

  it("eckEncrypt rejects an over-ceiling plaintext", () => {
    expect(() => eckEncrypt(generateEck(), tooBig)).toThrow(/over the 65535-byte ceiling/);
  });

  it("nip44Encrypt rejects an over-ceiling plaintext", () => {
    const sender = generateSecretKey();
    expect(() =>
      nip44Encrypt(sender, getPublicKey(generateSecretKey()), tooBig),
    ).toThrow(/over the 65535-byte ceiling/);
  });

  it("selfEncrypt rejects an over-ceiling plaintext", () => {
    expect(() => selfEncrypt(generateSecretKey(), tooBig)).toThrow(/over the 65535-byte ceiling/);
  });

  it("a plaintext exactly at the ceiling still round-trips", () => {
    const eck = generateEck();
    const atCeiling = "x".repeat(65_535);
    expect(eckDecrypt(eck, eckEncrypt(eck, atCeiling))).toBe(atCeiling);
  });
});

describe("NIP-44 decrypt ciphertext ceiling (P10)", () => {
  // The base64 envelope of a 65,535-byte plaintext (the encrypt ceiling) is
  // exactly 87,472 chars: ceil((1 + 32 + (2 + 65536) + 32) / 3) * 4. Longer input
  // cannot be a valid within-ceiling NIP-44 v2 payload, so decrypt must reject it
  // before base64-decoding/allocating.
  const MAX_B64 = 87_472;

  it("the max-plaintext ciphertext is exactly at the boundary and round-trips", () => {
    const eck = generateEck();
    const ct = eckEncrypt(eck, "x".repeat(65_535));
    expect(ct.length).toBe(MAX_B64);
    expect(eckDecrypt(eck, ct)).toBe("x".repeat(65_535));
  });

  it("eckDecrypt rejects ciphertext one char over the ceiling before decoding", () => {
    const eck = generateEck();
    const overCeiling = "A".repeat(MAX_B64 + 1);
    expect(() => eckDecrypt(eck, overCeiling)).toThrow(/ciphertext .* ceiling/);
  });

  it("nip44Decrypt rejects an over-ceiling ciphertext", () => {
    const recipient = generateSecretKey();
    const senderPk = getPublicKey(generateSecretKey());
    expect(() =>
      nip44Decrypt(recipient, senderPk, "A".repeat(MAX_B64 + 1)),
    ).toThrow(/ciphertext .* ceiling/);
  });

  it("selfDecrypt rejects an over-ceiling ciphertext", () => {
    expect(() =>
      selfDecrypt(generateSecretKey(), "A".repeat(MAX_B64 + 1)),
    ).toThrow(/ciphertext .* ceiling/);
  });

  it("a normal short ciphertext still round-trips on every decrypt path", () => {
    const eck = generateEck();
    expect(eckDecrypt(eck, eckEncrypt(eck, "hi"))).toBe("hi");
    const sk = generateSecretKey();
    const to = generateSecretKey();
    const ct = nip44Encrypt(sk, getPublicKey(to), "yo");
    expect(nip44Decrypt(to, getPublicKey(sk), ct)).toBe("yo");
    expect(selfDecrypt(sk, selfEncrypt(sk, "me"))).toBe("me");
  });
});

describe("NIP-44 ciphertext shape guard", () => {
  /**
   * The point of this guard is NOT correctness of decryption — a wrong payload
   * fails either way. It is that a REMOTE signer's failure is expensive: a relay
   * round trip to someone's phone, and on Clave (iOS) a "Signing Failed" push
   * notification the user sees. Reported 2026-09-17: a recurring
   * "nip44_decrypt failed: Invalid base64" that was this account's own kind-10000
   * mute list, written by another client in 2024 with NIP-04. We had been asking
   * their signer to decrypt `<base64>?iv=<base64>` on every visit to any
   * mute-aware screen.
   */
  it("accepts what our own encrypt produces, at both ends of the size range", () => {
    const sk = generateSecretKey();
    expect(isNip44Ciphertext(selfEncrypt(sk, "x"))).toBe(true);
    expect(isNip44Ciphertext(selfEncrypt(sk, "x".repeat(65_535)))).toBe(true);
    const eck = generateEck();
    expect(isNip44Ciphertext(eckEncrypt(eck, "hello"))).toBe(true);
  });

  it("rejects the reported NIP-04 payload", () => {
    // Verbatim from the reporting account's kind-10000 (16-byte ciphertext, so
    // its plaintext was at most 15 bytes: an empty list).
    const nip04 = "f+/YOKe898cbiM09+vtfyA==?iv=jwq9ef0jRSVZGPVQZqltfw==";
    expect(isNip44Ciphertext(nip04)).toBe(false);
    expect(isNip04Ciphertext(nip04)).toBe(true);
  });

  it("rejects everything else a strict decoder would", () => {
    const sk = generateSecretKey();
    const valid = selfEncrypt(sk, "x");
    expect(isNip44Ciphertext("")).toBe(false); // an empty replaceable-event content
    expect(isNip44Ciphertext(undefined)).toBe(false);
    expect(isNip44Ciphertext("Records read time to sync across devices.")).toBe(false);
    expect(isNip44Ciphertext(valid.slice(0, -1))).toBe(false); // truncated: length % 4
    expect(isNip44Ciphertext(`${valid.slice(0, -4)}-_==`)).toBe(false); // URL-safe alphabet
    expect(isNip44Ciphertext(`#${valid.slice(1)}`)).toBe(false); // future version marker
    expect(isNip44Ciphertext("A".repeat(128))).toBe(false); // under the 132 floor
    expect(isNip44Ciphertext("A".repeat(87_476))).toBe(false); // over the ceiling
  });

  it("is a shape test only, and says so honestly", () => {
    // 132 chars of valid base64 is indistinguishable from a real payload here.
    // Proving it decrypts is the signer's job; this only stops us wasting its time.
    expect(isNip44Ciphertext("A".repeat(132))).toBe(true);
  });
});
