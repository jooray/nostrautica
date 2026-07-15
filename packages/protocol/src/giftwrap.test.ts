import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, finalizeEvent, getEventHash } from "nostr-tools/pure";
import { nip44Encrypt } from "./crypto.js";
import {
  wrapRumor,
  unwrapRumor,
  rumorPayload,
  giftwrapSince,
} from "./giftwrap.js";
import { KIND_JOIN_REQUEST, KIND_GIFT_WRAP, KIND_SEAL } from "./kinds.js";
import { joinRequestContentSchema } from "./schemas.js";

describe("gift wrap (NIP-59)", () => {
  it("wraps and unwraps a join-request rumor", () => {
    const sender = generateSecretKey();
    const inboxSk = generateSecretKey();
    const inboxPk = getPublicKey(inboxSk);

    const payload = { v: 1, name: "Alice", message: "let me in", rsvp_public: false };
    const wrap = wrapRumor(sender, inboxPk, {
      kind: KIND_JOIN_REQUEST,
      content: payload,
      tags: [["a", "31923:" + "a".repeat(64) + ":ev"]],
    });

    // The wrap is a kind-1059 event with a random one-time author and a single p-tag.
    expect(wrap.kind).toBe(KIND_GIFT_WRAP);
    expect(wrap.pubkey).not.toBe(getPublicKey(sender)); // one-time key hides sender
    expect(wrap.tags).toEqual([["p", inboxPk]]);
    expect(wrap.sig).toBeTruthy();

    const rumor = unwrapRumor(wrap, inboxSk);
    expect(rumor.kind).toBe(KIND_JOIN_REQUEST);
    expect(rumor.pubkey).toBe(getPublicKey(sender)); // seal reveals true author
    expect(rumor.sig).toBeUndefined(); // rumors are never signed

    const parsed = joinRequestContentSchema.parse(rumorPayload(rumor));
    expect(parsed.name).toBe("Alice");
  });

  it("cannot be unwrapped by the wrong recipient", () => {
    const sender = generateSecretKey();
    const inboxPk = getPublicKey(generateSecretKey());
    const wrap = wrapRumor(sender, inboxPk, {
      kind: KIND_JOIN_REQUEST,
      content: { v: 1, name: "x" },
    });
    expect(() => unwrapRumor(wrap, generateSecretKey())).toThrow();
  });

  it("rejects a rumor whose claimed author differs from the seal author (NIP-59 binding)", () => {
    // An attacker seals with their OWN key but writes someone else's pubkey into
    // the rumor (e.g. an event's E_id, to forge a 21603/21604). The seal author is
    // authenticated by NIP-44 decryption; the rumor's pubkey field is not — so
    // unwrapRumor must enforce rumor.pubkey === seal.pubkey.
    const attackerSk = generateSecretKey();
    const victimPk = getPublicKey(generateSecretKey()); // impersonation target
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);

    // Build the forged rumor + seal + wrap by hand (wrapRumor derives the rumor
    // author from the sealing key, so a forger has to go around it — as here).
    const forgedRumor = {
      pubkey: victimPk, // lie: claims the victim authored it
      created_at: 1,
      kind: KIND_JOIN_REQUEST,
      tags: [],
      content: JSON.stringify({ v: 1, name: "mallory" }),
    };
    const rumorWithId = { ...forgedRumor, id: getEventHash(forgedRumor) };
    const seal = finalizeEvent(
      { kind: KIND_SEAL, created_at: 1, tags: [], content: nip44Encrypt(attackerSk, recipientPk, JSON.stringify(rumorWithId)) },
      attackerSk,
    );
    const otSk = generateSecretKey();
    const wrap = finalizeEvent(
      { kind: KIND_GIFT_WRAP, created_at: 1, tags: [["p", recipientPk]], content: nip44Encrypt(otSk, recipientPk, JSON.stringify(seal)) },
      otSk,
    );

    expect(() => unwrapRumor(wrap as any, recipientSk)).toThrow(/author mismatch/);
  });

  it("randomizes wrap timestamp into the past (within 2 days)", () => {
    const now = Math.floor(Date.now() / 1000);
    const wrap = wrapRumor(generateSecretKey(), getPublicKey(generateSecretKey()), {
      kind: KIND_JOIN_REQUEST,
      content: { v: 1, name: "x" },
    });
    expect(wrap.created_at).toBeLessThanOrEqual(now + 5);
    expect(wrap.created_at).toBeGreaterThanOrEqual(now - 2 * 24 * 60 * 60 - 5);
  });

  it("seal is kind 13", () => {
    // Indirectly: unwrap works, and the wrap content decrypts to a seal — covered
    // by the round-trip. Here we assert the constant matches NIP-59.
    expect(KIND_SEAL).toBe(13);
  });

  it("giftwrapSince is now − 3 days", () => {
    expect(giftwrapSince(1_000_000)).toBe(1_000_000 - 3 * 86400);
  });
});
