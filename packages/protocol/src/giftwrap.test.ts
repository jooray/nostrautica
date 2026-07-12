import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
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
