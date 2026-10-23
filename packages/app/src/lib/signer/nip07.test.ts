/**
 * Audit R-37: the NIP-07 signer verified only the signature, so an extension
 * that had switched accounts, or that rewrote the template, had its output
 * accepted and published as the adopted identity's. It now binds the result
 * to pubkey + template, exactly like the NIP-46 signer.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";
import { Nip07Signer } from "./nip07.js";

const template: EventTemplate = { kind: 1, created_at: 1_700_000_000, content: "hi", tags: [["t", "x"]] };

function stubExtension(adopted: Uint8Array, signer: Uint8Array, rewrite?: (t: EventTemplate) => EventTemplate) {
  vi.stubGlobal("window", {
    nostr: {
      getPublicKey: async () => getPublicKey(adopted),
      signEvent: async (t: EventTemplate) => finalizeEvent(rewrite ? rewrite(t) : t, signer),
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Nip07Signer.signEvent (R-37)", () => {
  it("returns an event signed by the adopted key over the requested template", async () => {
    const sk = generateSecretKey();
    stubExtension(sk, sk);
    const ev = await new Nip07Signer().signEvent(template);
    expect(ev.pubkey).toBe(getPublicKey(sk));
    expect(ev.content).toBe("hi");
  });

  it("rejects a validly signed event from a different key", async () => {
    stubExtension(generateSecretKey(), generateSecretKey());
    await expect(new Nip07Signer().signEvent(template)).rejects.toThrow(/different event/);
  });

  it("rejects a validly signed event whose content or tags were rewritten", async () => {
    const sk = generateSecretKey();
    stubExtension(sk, sk, (t) => ({ ...t, content: "not what you asked" }));
    await expect(new Nip07Signer().signEvent(template)).rejects.toThrow(/different event/);
    stubExtension(sk, sk, (t) => ({ ...t, tags: [...t.tags, ["p", "ff".repeat(32)]] }));
    await expect(new Nip07Signer().signEvent(template)).rejects.toThrow(/different event/);
  });
});
