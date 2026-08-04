import { describe, it, expect } from "vitest";
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
