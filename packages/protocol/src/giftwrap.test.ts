import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, finalizeEvent, getEventHash } from "nostr-tools/pure";
import { nip44Encrypt } from "./crypto.js";
import {
  wrapRumor,
  unwrapRumor,
  unwrapRumorEnvelope,
  rumorEffectiveCreatedAt,
  rumorPayload,
  giftwrapSince,
  RUMOR_MAX_CLOCK_SKEW_SEC,
} from "./giftwrap.js";
import { KIND_JOIN_REQUEST, KIND_GIFT_WRAP, KIND_SEAL } from "./kinds.js";
import { joinRequestContentSchema } from "./schemas.js";

/**
 * Build a gift wrap around an arbitrary (possibly malformed) rumor, sealed by
 * `senderSk` — the path a hand-rolling attacker takes, since wrapRumor always
 * derives a well-formed rumor from the sealing key.
 */
function wrapRawRumor(senderSk: Uint8Array, recipientPk: string, rumor: unknown) {
  const seal = finalizeEvent(
    {
      kind: KIND_SEAL,
      created_at: 1,
      tags: [],
      content: nip44Encrypt(senderSk, recipientPk, JSON.stringify(rumor)),
    },
    senderSk,
  );
  const otSk = generateSecretKey();
  return finalizeEvent(
    {
      kind: KIND_GIFT_WRAP,
      created_at: 1,
      tags: [["p", recipientPk]],
      content: nip44Encrypt(otSk, recipientPk, JSON.stringify(seal)),
    },
    otSk,
  );
}

describe("gift wrap (NIP-59)", () => {
  it("wraps and unwraps a join-request rumor", () => {
    const sender = generateSecretKey();
    const inboxSk = generateSecretKey();
    const inboxPk = getPublicKey(inboxSk);

    const payload = { v: 2, name: "Alice", message: "let me in", rsvp_public: false };
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
      content: { v: 2, name: "x" },
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
      content: JSON.stringify({ v: 2, name: "mallory" }),
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
      content: { v: 2, name: "x" },
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

describe("unwrap boundary validation (PROTO-2)", () => {
  it("rejects a rumor with missing or mistyped fields", () => {
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    // pubkey must equal the seal author so the structural checks are reached.
    const base = {
      id: "a".repeat(64),
      pubkey: getPublicKey(senderSk),
      created_at: 1,
      kind: KIND_JOIN_REQUEST,
      tags: [],
      content: "{}",
    };
    const unwrap = (rumor: unknown) => () =>
      unwrapRumor(wrapRawRumor(senderSk, recipientPk, rumor) as any, recipientSk);
    // A missing `tags` used to cross the boundary and crash downstream
    // consumers (`rumor.tags.find` TypeError).
    expect(unwrap({ ...base, tags: undefined })).toThrow(/tags/);
    expect(unwrap({ ...base, tags: ["not-an-array"] })).toThrow(/tags/);
    expect(unwrap({ ...base, id: "not-hex" })).toThrow(/id/);
    expect(unwrap({ ...base, pubkey: "A".repeat(64) })).toThrow(/pubkey/);
    expect(unwrap({ ...base, kind: "21600" })).toThrow(/kind/);
    expect(unwrap({ ...base, kind: -1 })).toThrow(/kind/);
    expect(unwrap({ ...base, created_at: "now" })).toThrow(/created_at/);
    expect(unwrap({ ...base, content: 42 })).toThrow(/content/);
    expect(unwrap(null)).toThrow(/not an object/);
  });

  it("rejects a rumor whose id does not match its contents", () => {
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    const rumor = {
      id: "0".repeat(64), // well-formed hex, but not the hash of the contents
      pubkey: getPublicKey(senderSk),
      created_at: 1,
      kind: KIND_JOIN_REQUEST,
      tags: [],
      content: "{}",
    };
    expect(() =>
      unwrapRumor(wrapRawRumor(senderSk, recipientPk, rumor) as any, recipientSk),
    ).toThrow(/id does not match/);
  });

  it("accepts a hand-rolled rumor whose id matches the recomputed hash", () => {
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    const unsigned = {
      pubkey: getPublicKey(senderSk),
      created_at: 1,
      kind: KIND_JOIN_REQUEST,
      tags: [["a", "31923:" + "a".repeat(64) + ":ev"]],
      content: JSON.stringify({ v: 2, name: "honest" }),
    };
    const rumor = { ...unsigned, id: getEventHash(unsigned) };
    const unwrapped = unwrapRumor(
      wrapRawRumor(senderSk, recipientPk, rumor) as any,
      recipientSk,
    );
    expect(unwrapped.id).toBe(rumor.id);
    expect(unwrapped.pubkey).toBe(getPublicKey(senderSk));
    expect(unwrapped.tags).toEqual(unsigned.tags);
  });
});

/** Wrap an arbitrary (possibly unsigned/forged) seal object to `recipientPk`. */
function wrapSealObject(recipientPk: string, sealObj: unknown) {
  const otSk = generateSecretKey();
  return finalizeEvent(
    {
      kind: KIND_GIFT_WRAP,
      created_at: 1,
      tags: [["p", recipientPk]],
      content: nip44Encrypt(otSk, recipientPk, JSON.stringify(sealObj)),
    },
    otSk,
  );
}

describe("seal signature verification (P1)", () => {
  // The core forgery (audit "missing test #1"): the attacker holds ONLY the
  // recipient secret and a victim's PUBLIC key. Because ECDH(recipientSk, victimPk)
  // == ECDH(victimSk, recipientPk), they can produce a seal.content that decrypts
  // cleanly under the recipient key while claiming the victim as author — but they
  // cannot sign a kind-13 as the victim. Every unwrap path must reject it.
  it("rejects a validly-encrypted seal that lacks a valid signature (forged author)", () => {
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    const victimPk = getPublicKey(generateSecretKey()); // no victim secret used

    const forgedRumorBase = {
      pubkey: victimPk, // lie: attributes the action to the victim
      created_at: 1,
      kind: KIND_JOIN_REQUEST,
      tags: [] as string[][],
      content: JSON.stringify({ v: 2, name: "mallory" }),
    };
    const forgedRumor = { ...forgedRumorBase, id: getEventHash(forgedRumorBase) };
    // Encrypt the seal content with the RECIPIENT secret under the victim pubkey —
    // the whole point: NIP-44 decryption succeeds, only the signature check saves us.
    const sealContent = nip44Encrypt(recipientSk, victimPk, JSON.stringify(forgedRumor));

    // (a) signature absent entirely (valid id, so the sig check is the one to fire)
    const unsigned = {
      pubkey: victimPk,
      created_at: 1,
      kind: KIND_SEAL,
      tags: [] as string[][],
      content: sealContent,
    };
    expect(() =>
      unwrapRumor(
        wrapSealObject(recipientPk, {
          ...unsigned,
          id: getEventHash(unsigned as any),
        }) as any,
        recipientSk,
      ),
    ).toThrow(/seal sig is not/);

    // (b) signature present but bogus (well-formed hex, does not verify)
    const bogus = {
      pubkey: victimPk,
      created_at: 1,
      kind: KIND_SEAL,
      tags: [] as string[][],
      content: sealContent,
    };
    const bogusSealed = {
      ...bogus,
      id: getEventHash(bogus as any),
      sig: "0".repeat(128),
    };
    expect(() =>
      unwrapRumor(wrapSealObject(recipientPk, bogusSealed) as any, recipientSk),
    ).toThrow(/seal signature is invalid/);
  });

  it("rejects a seal whose id was tampered after signing", () => {
    const attackerSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    const rumorBase = {
      pubkey: getPublicKey(attackerSk),
      created_at: 1,
      kind: KIND_JOIN_REQUEST,
      tags: [] as string[][],
      content: JSON.stringify({ v: 2, name: "x" }),
    };
    const rumor = { ...rumorBase, id: getEventHash(rumorBase) };
    const seal = finalizeEvent(
      {
        kind: KIND_SEAL,
        created_at: 1,
        tags: [],
        content: nip44Encrypt(attackerSk, recipientPk, JSON.stringify(rumor)),
      },
      attackerSk,
    );
    const tampered = { ...seal, id: "f".repeat(64) }; // still hex, no longer the hash
    expect(() =>
      unwrapRumor(wrapSealObject(recipientPk, tampered) as any, recipientSk),
    ).toThrow(/seal signature is invalid/);
  });

  it("rejects a seal with non-empty tags (NIP-59 requires empty)", () => {
    const attackerSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    // A fully valid signature over a seal that carries tags — the empty-tags rule
    // must reject it before the (valid) signature is honored.
    const seal = finalizeEvent(
      {
        kind: KIND_SEAL,
        created_at: 1,
        tags: [["p", recipientPk]],
        content: nip44Encrypt(attackerSk, recipientPk, JSON.stringify({ x: 1 })),
      },
      attackerSk,
    );
    expect(() =>
      unwrapRumor(wrapSealObject(recipientPk, seal) as any, recipientSk),
    ).toThrow(/tags must be empty/);
  });

  it("rejects an inner event whose kind is not 13", () => {
    const attackerSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    const notSeal = finalizeEvent(
      {
        kind: KIND_SEAL + 1,
        created_at: 1,
        tags: [],
        content: nip44Encrypt(attackerSk, recipientPk, JSON.stringify({ x: 1 })),
      },
      attackerSk,
    );
    expect(() =>
      unwrapRumor(wrapSealObject(recipientPk, notSeal) as any, recipientSk),
    ).toThrow(/not a seal/);
  });

  it("rejects a gift wrap whose outer signature is invalid", () => {
    const sender = generateSecretKey();
    const inboxSk = generateSecretKey();
    const inboxPk = getPublicKey(inboxSk);
    const wrap = wrapRumor(sender, inboxPk, {
      kind: KIND_JOIN_REQUEST,
      content: { v: 2, name: "x" },
    });
    const tampered = { ...wrap, sig: "0".repeat(128) };
    expect(() => unwrapRumor(tampered as any, inboxSk)).toThrow(
      /gift wrap signature is invalid/,
    );
  });

  it("still round-trips a legitimately signed seal", () => {
    const sender = generateSecretKey();
    const inboxSk = generateSecretKey();
    const inboxPk = getPublicKey(inboxSk);
    const wrap = wrapRumor(sender, inboxPk, {
      kind: KIND_JOIN_REQUEST,
      content: { v: 2, name: "legit" },
    });
    const rumor = unwrapRumor(wrap, inboxSk);
    expect(rumor.pubkey).toBe(getPublicKey(sender));
    expect(joinRequestContentSchema.parse(rumorPayload(rumor)).name).toBe("legit");
  });
});

describe("rumor created_at clamping (PROTO-8)", () => {
  it("clamps a future-dated rumor to now + RUMOR_MAX_CLOCK_SKEW_SEC", () => {
    const inboxSk = generateSecretKey();
    const now = Math.floor(Date.now() / 1000);
    const wrap = wrapRumor(generateSecretKey(), getPublicKey(inboxSk), {
      kind: KIND_JOIN_REQUEST,
      content: { v: 2, name: "time traveler" },
      created_at: now + 2 * 86400, // 2 days in the future
    });
    const rumor = unwrapRumor(wrap, inboxSk);
    expect(rumor.created_at).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000) + RUMOR_MAX_CLOCK_SKEW_SEC,
    );
    // clamped to the allowance boundary, not dropped to now
    expect(rumor.created_at).toBeGreaterThan(now);
  });

  it("leaves past and within-skew timestamps unchanged", () => {
    const inboxSk = generateSecretKey();
    const now = Math.floor(Date.now() / 1000);
    for (const ts of [now - 86400, now, now + 5 * 60 /* within the 15-min skew */]) {
      const wrap = wrapRumor(generateSecretKey(), getPublicKey(inboxSk), {
        kind: KIND_JOIN_REQUEST,
        content: { v: 2, name: "x" },
        created_at: ts,
      });
      expect(unwrapRumor(wrap, inboxSk).created_at).toBe(ts);
    }
  });
});

describe("unwrap envelope preserves authenticated fields (audit R19)", () => {
  it("returns the untouched rumor (created_at hashes to id) + a separate effectiveCreatedAt", () => {
    const inboxSk = generateSecretKey();
    const sender = generateSecretKey();
    const now = Math.floor(Date.now() / 1000);
    const future = now + 2 * 86400; // 2 days ahead
    const wrap = wrapRumor(sender, getPublicKey(inboxSk), {
      kind: KIND_JOIN_REQUEST,
      content: { v: 2, name: "time traveler" },
      created_at: future,
    });
    const { rumor, effectiveCreatedAt } = unwrapRumorEnvelope(wrap, inboxSk);
    // The rumor is AUTHENTICATED and UNMUTATED: created_at is exactly what was
    // signed, so recomputing its id over its own fields still matches (the R19 fix:
    // the clamp no longer breaks id integrity).
    expect(rumor.created_at).toBe(future);
    expect(rumor.id).toBe(
      getEventHash({
        pubkey: rumor.pubkey,
        created_at: rumor.created_at,
        kind: rumor.kind,
        tags: rumor.tags,
        content: rumor.content,
      }),
    );
    // effectiveCreatedAt is the clamped ordering value, separate from the rumor.
    expect(effectiveCreatedAt).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000) + RUMOR_MAX_CLOCK_SKEW_SEC,
    );
    expect(effectiveCreatedAt).toBeLessThan(future);
    // The backward-compat unwrapRumor still returns the clamped created_at (app path).
    expect(unwrapRumor(wrap, inboxSk).created_at).toBe(effectiveCreatedAt);
  });

  it("rumorEffectiveCreatedAt clamps only future timestamps", () => {
    const now = 1_000_000;
    expect(rumorEffectiveCreatedAt(now - 100, now)).toBe(now - 100);
    expect(rumorEffectiveCreatedAt(now, now)).toBe(now);
    expect(rumorEffectiveCreatedAt(now + RUMOR_MAX_CLOCK_SKEW_SEC - 1, now)).toBe(
      now + RUMOR_MAX_CLOCK_SKEW_SEC - 1,
    );
    expect(rumorEffectiveCreatedAt(now + 10 * 86400, now)).toBe(now + RUMOR_MAX_CLOCK_SKEW_SEC);
  });
});
