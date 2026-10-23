import { describe, it, expect } from "vitest";
import { getPublicKey, generateSecretKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import {
  buildChatSend,
  buildReactionSend,
  buildEditSend,
  buildDeleteSend,
  rumorToChatMessage,
  roundTripChatRumor,
  CHAT_KIND_TEXT,
  CHAT_KIND_REACTION,
  CHAT_KIND_EDIT,
  CHAT_KIND_DELETE,
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

  it("tags mentioned people the way MDK does for White Noise, and keeps them over the wire", () => {
    const mentioned = getPublicKey(generateSecretKey());
    const content = `ahoj @${npubEncode(mentioned)} and nostr:${npubEncode(mentioned)}`;
    const reply: string[][] = [["e", "f".repeat(64)]];
    const { rumor } = buildChatSend(pubkey, content, reply);
    // Caller tags first, then one p per distinct person (MDK mention_p_tags).
    expect(rumor.tags).toEqual([["e", "f".repeat(64)], ["p", mentioned]]);
    expect(roundTripChatRumor(rumor).tags).toEqual(rumor.tags);
    // A p the caller already supplied is not duplicated.
    expect(buildChatSend(pubkey, content, [["p", mentioned]]).rumor.tags).toEqual([["p", mentioned]]);
    // No mention, no tags at all: plain messages stay byte-identical to before.
    expect(buildChatSend(pubkey, "plain").rumor.tags).toEqual([]);
  });
});

describe("message modifiers (MDK build_inner_event wire format)", () => {
  const target = "e".repeat(64);

  it("a reaction is kind 7, content = the emoji, one e tag to the target", () => {
    const { rumor, intent } = buildReactionSend(pubkey, target, "👍");
    expect(rumor).toMatchObject({ kind: CHAT_KIND_REACTION, pubkey, content: "👍", tags: [["e", target]] });
    expect(intent.kind).toBe("applicationMessage");
    const back = roundTripChatRumor(rumor);
    expect(back).toMatchObject({ id: rumor.id, kind: CHAT_KIND_REACTION, tags: [["e", target]] });
  });

  it("refuses an empty or oversize reaction", () => {
    expect(() => buildReactionSend(pubkey, target, " ")).toThrow();
    expect(() => buildReactionSend(pubkey, target, "x".repeat(65))).toThrow();
  });

  it("an edit is kind 1009 with the e tag first, then the new text's mention p tags", () => {
    const mentioned = getPublicKey(generateSecretKey());
    const { rumor } = buildEditSend(pubkey, target, `now with @${npubEncode(mentioned)}`);
    expect(rumor.kind).toBe(CHAT_KIND_EDIT);
    expect(rumor.tags).toEqual([["e", target], ["p", mentioned]]);
    expect(roundTripChatRumor(rumor).tags).toEqual(rumor.tags);
    expect(buildEditSend(pubkey, target, "plain").rumor.tags).toEqual([["e", target]]);
    expect(() => buildEditSend(pubkey, target, "  ")).toThrow();
  });

  it("a delete is kind 5, empty content, one e tag per retracted event (deduped)", () => {
    const other = "d".repeat(64);
    const { rumor } = buildDeleteSend(pubkey, [target, other, target]);
    expect(rumor).toMatchObject({ kind: CHAT_KIND_DELETE, content: "", tags: [["e", target], ["e", other]] });
    expect(roundTripChatRumor(rumor).id).toBe(rumor.id);
    expect(() => buildDeleteSend(pubkey, [])).toThrow();
  });
});
