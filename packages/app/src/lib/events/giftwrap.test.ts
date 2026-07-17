import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  wrapRumor,
  unwrapRumor,
  KIND_JOIN_REQUEST,
  joinRequestContentSchema,
} from "@nostrautica/protocol";
import { signerWrap, signerUnwrap } from "./giftwrap.js";
import { LocalSigner } from "$lib/signer/local.js";

const payload = { v: 1, name: "Alice", message: "hi", rsvp_public: false };

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
});
