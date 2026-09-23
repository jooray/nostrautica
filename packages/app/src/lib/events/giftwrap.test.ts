import { describe, it, expect, vi } from "vitest";
import { generateSecretKey, getPublicKey, getEventHash, finalizeEvent } from "nostr-tools/pure";
import {
  wrapRumor,
  unwrapRumor,
  nip44Encrypt,
  KIND_GIFT_WRAP,
  KIND_JOIN_REQUEST,
  KIND_SEAL,
  RUMOR_MAX_CLOCK_SKEW_SEC,
  joinRequestContentSchema,
} from "@nostrautica/protocol";
import { signerWrap, signerUnwrap } from "./giftwrap.js";
import { LocalSigner } from "$lib/signer/local.js";

const payload = { v: 2, name: "Alice", message: "hi", rsvp_public: false };

describe("signer-based gift wrap ↔ protocol raw-key gift wrap", () => {
  it("app-wrapped rumor is unwrappable by the protocol raw-key path (coordinator side)", async () => {
    const sender = LocalSigner.generate();
    const inboxSk = generateSecretKey();
    const inboxPk = getPublicKey(inboxSk);

    const wrap = await signerWrap(sender, inboxPk, {
      kind: KIND_JOIN_REQUEST,
      content: payload,
      tags: [["a", "31923:" + "a".repeat(64) + ":ev"]],
    });

    const rumor = unwrapRumor(wrap, inboxSk);
    expect(rumor.kind).toBe(KIND_JOIN_REQUEST);
    expect(rumor.pubkey).toBe(await sender.getPublicKey());
    expect(joinRequestContentSchema.parse(JSON.parse(rumor.content)).name).toBe("Alice");
  });

  it("protocol-wrapped rumor is unwrappable by the app signer path (client side)", async () => {
    const senderSk = generateSecretKey();
    const recipient = LocalSigner.generate();
    const recipientPk = await recipient.getPublicKey();

    const wrap = wrapRumor(senderSk, recipientPk, {
      kind: KIND_JOIN_REQUEST,
      content: payload,
    });

    const rumor = await signerUnwrap(recipient, wrap);
    expect(rumor.pubkey).toBe(getPublicKey(senderSk));
    expect(JSON.parse(rumor.content).name).toBe("Alice");
  });

  it("the wrap hides the sender (one-time author) and p-tags only the recipient", async () => {
    const sender = LocalSigner.generate();
    const recipientPk = getPublicKey(generateSecretKey());
    const wrap = await signerWrap(sender, recipientPk, {
      kind: KIND_JOIN_REQUEST,
      content: payload,
    });
    expect(wrap.pubkey).not.toBe(await sender.getPublicKey());
    expect(wrap.tags).toEqual([["p", recipientPk]]);
  });

  it("a wrong recipient cannot unwrap", async () => {
    const sender = LocalSigner.generate();
    const recipientPk = getPublicKey(generateSecretKey());
    const wrap = await signerWrap(sender, recipientPk, {
      kind: KIND_JOIN_REQUEST,
      content: payload,
    });
    const wrongSigner = LocalSigner.generate();
    await expect(signerUnwrap(wrongSigner, wrap)).rejects.toBeDefined();
  });

  it("rejects a forged seal that decrypts but has no valid signature (P1)", async () => {
    // The recipient's own key is enough to encrypt a seal claiming any author —
    // ECDH(recipientSk, victimPk) == ECDH(victimSk, recipientPk) — but not to sign
    // a kind-13 as the victim. signerUnwrap must reject it, matching unwrapRumor.
    const recipient = LocalSigner.generate();
    const recipientPk = await recipient.getPublicKey();
    const victimPk = getPublicKey(generateSecretKey()); // no victim secret

    const rumorBase = {
      pubkey: victimPk,
      created_at: 1,
      kind: KIND_JOIN_REQUEST,
      tags: [] as string[][],
      content: JSON.stringify({ v: 2, name: "mallory" }),
    };
    const rumor = { ...rumorBase, id: getEventHash(rumorBase) };
    // Encrypt the seal content to the recipient using the recipient signer itself
    // (stands in for "attacker holds recipientSk"), then attach a bogus signature.
    const sealContent = await recipient.nip44Encrypt(victimPk, JSON.stringify(rumor));
    const sealBase = {
      pubkey: victimPk,
      created_at: 1,
      kind: KIND_SEAL,
      tags: [] as string[][],
      content: sealContent,
    };
    const forgedSeal = { ...sealBase, id: getEventHash(sealBase), sig: "0".repeat(128) };
    const otSk = generateSecretKey();
    const wrap = finalizeEvent(
      {
        kind: KIND_GIFT_WRAP,
        created_at: 1,
        tags: [["p", recipientPk]],
        content: nip44Encrypt(otSk, recipientPk, JSON.stringify(forgedSeal)),
      },
      otSk,
    );
    await expect(signerUnwrap(recipient, wrap as never)).rejects.toThrow(
      /seal signature is invalid/,
    );
  });

  it("clamps a future-dated rumor's created_at (PROTO-8)", async () => {
    const sender = LocalSigner.generate();
    const recipient = LocalSigner.generate();
    const recipientPk = await recipient.getPublicKey();
    const senderPk = await sender.getPublicKey();
    const now = Math.floor(Date.now() / 1000);
    const future = now + 3 * 24 * 60 * 60; // 3 days ahead — wins any latest-wins pick

    // Hand-build a NIP-59 wrap whose rumor is future-dated (signerWrap's exact
    // construction, but with a chosen rumor created_at).
    const rumorBase = {
      pubkey: senderPk,
      created_at: future,
      kind: KIND_JOIN_REQUEST,
      tags: [] as string[][],
      content: JSON.stringify(payload),
    };
    const rumor = { ...rumorBase, id: getEventHash(rumorBase) };
    const seal = await sender.signEvent({
      kind: KIND_SEAL,
      created_at: now - 60,
      tags: [],
      content: await sender.nip44Encrypt(recipientPk, JSON.stringify(rumor)),
    });
    const otSk = generateSecretKey();
    const wrap = finalizeEvent(
      {
        kind: KIND_GIFT_WRAP,
        created_at: now - 60,
        tags: [["p", recipientPk]],
        content: nip44Encrypt(otSk, recipientPk, JSON.stringify(seal)),
      },
      otSk,
    );

    const unwrapped = await signerUnwrap(recipient, wrap as never);
    // Ceiling read AFTER the unwrap, not from the `now` captured at the top: the
    // clamp calls Date.now() itself, so a single second ticking over between the
    // two made this fail with an off-by-one-second — the 15-minute skew cancels
    // on both sides and leaves a bare `now + 1 > now` comparison. Sampling the
    // ceiling once the clamp has already run makes the bound unbeatable.
    const clampCeiling = Math.floor(Date.now() / 1000) + RUMOR_MAX_CLOCK_SKEW_SEC;
    // Clamped to at most now + skew — the 3-day head start is gone.
    expect(unwrapped.created_at).toBeLessThanOrEqual(clampCeiling);
    expect(unwrapped.created_at).toBeLessThan(future);
  });
});

/**
 * The unwrap path must bound the ciphertext BEFORE handing it to the signer
 * (audit PROTO-1).
 *
 * `signerUnwrap` delegates decryption to the user's signer: for NIP-07 that hands
 * the raw string to a browser extension, and for NIP-46 it ships the whole thing
 * to a remote bunker over a relay and waits for an answer. Nothing on that path
 * had an upper bound — the protocol's ceiling guards only its own in-process
 * decrypts — so a few thousand kind-1059 events `#p`-tagged at someone, each
 * carrying an 800 KB `content`, are enough to stall the signer session through
 * the ordinary DM and grant scans.
 */
describe("signerUnwrap refuses an oversized ciphertext before touching the signer", () => {
  /** A signed kind-1059 whose content is far past any legal NIP-44 payload. */
  function oversizedWrap(recipientPubkey: string) {
    const throwaway = generateSecretKey();
    return finalizeEvent(
      {
        kind: KIND_GIFT_WRAP,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", recipientPubkey]],
        content: "A".repeat(800_000),
      },
      throwaway,
    );
  }

  it("throws without calling the signer at all", async () => {
    const me = LocalSigner.generate();
    let decryptCalls = 0;
    const counting = {
      ...me,
      getPublicKey: () => me.getPublicKey(),
      nip44Decrypt: async (pk: string, ct: string) => {
        decryptCalls++;
        return me.nip44Decrypt(pk, ct);
      },
    } as unknown as LocalSigner;

    const wrap = oversizedWrap(await me.getPublicKey());
    await expect(signerUnwrap(counting, wrap as never)).rejects.toThrow(/ceiling/i);
    // The point is not that it fails — it would have failed eventually. It is that
    // the signer was never asked, so a flood of these costs no signer round-trips.
    expect(decryptCalls).toBe(0);
  });

  it("still round-trips a normal wrap", async () => {
    const sender = LocalSigner.generate();
    const me = LocalSigner.generate();
    const wrap = await signerWrap(sender, await me.getPublicKey(), {
      kind: KIND_JOIN_REQUEST,
      content: payload,
      tags: [],
    });
    const rumor = await signerUnwrap(me, wrap);
    expect(joinRequestContentSchema.parse(JSON.parse(rumor.content)).name).toBe("Alice");
  });
});

/**
 * The wrap timestamp offset is a PRIVACY parameter (audit PROTO-2): it is what
 * stops `created_at` from revealing when its author actually sent the wrap. It
 * came from `Math.random`, whose V8 xorshift state is recoverable from a handful
 * of outputs — so someone collecting an author's wraps could predict the rest of
 * the sequence and subtract the offset back off.
 */
describe("wrap timestamps are randomized from a CSPRNG", () => {
  it("draws the offset from crypto.getRandomValues, not Math.random", async () => {
    const sender = LocalSigner.generate();
    const me = await LocalSigner.generate().getPublicKey();
    const mathRandom = vi.spyOn(Math, "random");
    const csprng = vi.spyOn(globalThis.crypto, "getRandomValues");
    try {
      await signerWrap(sender, me, { kind: KIND_JOIN_REQUEST, content: payload, tags: [] });
      expect(csprng).toHaveBeenCalled();
      expect(mathRandom).not.toHaveBeenCalled();
    } finally {
      mathRandom.mockRestore();
      csprng.mockRestore();
    }
  });

  it("still lands within the NIP-59 two-day window, in the past", async ({ onTestFinished }) => {
    const sender = LocalSigner.generate();
    const me = await LocalSigner.generate().getPublicKey();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    onTestFinished(() => clock.mockRestore());
    const now = Math.floor(Date.now() / 1000);
    const random = crypto.getRandomValues.bind(crypto);
    let draw = 0;
    const rng = vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      // Only control the timestamp draw; real keys/nonces keep real randomness.
      if (array instanceof Uint32Array && array.length === 1) {
        array[0] = draw;
        return array;
      }
      return random(array);
    });
    onTestFinished(() => rng.mockRestore());
    // Exercise both endpoints instead of paying for thirty random crypto wraps
    // that almost never hit either boundary and time out under suite contention.
    for (const [input, offset] of [[0, 0], [0xffffffff, 2 * 24 * 60 * 60 - 1]]) {
      draw = input;
      const wrap = await signerWrap(sender, me, { kind: KIND_JOIN_REQUEST, content: payload, tags: [] });
      expect(wrap.created_at).toBe(now - offset);
    }
  });
});
