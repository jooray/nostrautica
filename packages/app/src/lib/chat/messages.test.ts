import { describe, it, expect } from "vitest";
import { getPublicKey, generateSecretKey } from "nostr-tools/pure";
import {
  buildChatSend,
  rumorToChatMessage,
  roundTripChatRumor,
  CHAT_KIND_TEXT,
} from "./messages.js";

const pubkey = getPublicKey(generateSecretKey());

describe("chat message mapping", () => {
  it("buildChatSend produces a kind-9 rumor authored by the sender + a matching intent", () => {
    const { rumor, intent } = buildChatSend(pubkey, "hello world");
    expect(rumor.kind).toBe(CHAT_KIND_TEXT);
    expect(rumor.pubkey).toBe(pubkey);
    expect(rumor.content).toBe("hello world");
    expect(rumor.id).toMatch(/^[0-9a-f]{64}$/);
    expect(intent.kind).toBe("applicationMessage");
  });

  it("rumorToChatMessage maps every field", () => {
    const { rumor } = buildChatSend(pubkey, "hi", [["e", "f".repeat(64)]]);
    const msg = rumorToChatMessage(rumor);
    expect(msg).toEqual({
      id: rumor.id,
      pubkey,
      kind: CHAT_KIND_TEXT,
      content: "hi",
      createdAt: rumor.created_at,
      tags: [["e", "f".repeat(64)]],
    });
  });

  it("survives the Marmot serialize→deserialize wire round-trip byte-for-byte", () => {
    // This exercises the real marmot-ts application-rumor codec (id recomputation,
    // strict field set) — the exact path a 445 payload takes through MLS.
    const { rumor } = buildChatSend(pubkey, "round trip ✓");
    const back = roundTripChatRumor(rumor);
    expect(back.id).toBe(rumor.id);
    expect(back.pubkey).toBe(pubkey);
    expect(back.content).toBe("round trip ✓");
    expect(back.kind).toBe(CHAT_KIND_TEXT);
  });

  it("rejects a tampered rumor whose id no longer matches its contents", () => {
    const { rumor } = buildChatSend(pubkey, "authentic");
    const tampered = { ...rumor, content: "forged" }; // id no longer matches
    expect(() => roundTripChatRumor(tampered)).toThrow();
  });
});
