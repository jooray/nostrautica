import { describe, it, expect } from "vitest";
import { verifyEvent } from "nostr-tools/pure";
import { buildAuthEvent, authHeader } from "./auth.js";
import { LocalSigner } from "$lib/signer/local.js";
import { base64ToBytes, KIND_BLOSSOM_AUTH } from "@nostrautica/protocol";

describe("Blossom auth event (kind 24242)", () => {
  it("builds a signed upload auth with t/x/expiration tags", async () => {
    const signer = LocalSigner.generate();
    const event = await buildAuthEvent(signer, {
      verb: "upload",
      sha256: "a".repeat(64),
      expirationSec: 2_000_000_000,
    });
    expect(event.kind).toBe(KIND_BLOSSOM_AUTH);
    expect(verifyEvent(event)).toBe(true);
    expect(event.tags).toContainEqual(["t", "upload"]);
    expect(event.tags).toContainEqual(["x", "a".repeat(64)]);
    expect(event.tags).toContainEqual(["expiration", "2000000000"]);
  });

  it("authHeader is 'Nostr <base64(json)>' and decodes to the event", async () => {
    const signer = LocalSigner.generate();
    const event = await buildAuthEvent(signer, { verb: "get" });
    const header = authHeader(event);
    expect(header.startsWith("Nostr ")).toBe(true);
    const decoded = JSON.parse(
      new TextDecoder().decode(base64ToBytes(header.slice("Nostr ".length))),
    );
    expect(decoded.id).toBe(event.id);
    expect(decoded.sig).toBe(event.sig);
  });
});
