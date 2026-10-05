import { describe, it, expect } from "vitest";
import { CHAT_LINK_CODE_ALPHABET, CHAT_LINK_CODE_LENGTH } from "@nostrautica/protocol";
import {
  generateChatLinkCode,
  formatChatLinkCode,
  hashChatLinkCode,
  chatLinkCodeMatches,
  chatLinkCodeMessages,
} from "./link-code.js";

const COORD = "31923:" + "e".repeat(64) + ":ev";
const A = "a".repeat(64);
const W = "b".repeat(64);

describe("link codes (NIP §10.5)", () => {
  it("generates codes of the right length from the unambiguous alphabet", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = generateChatLinkCode();
      expect(c).toHaveLength(CHAT_LINK_CODE_LENGTH);
      for (const ch of c) expect(CHAT_LINK_CODE_ALPHABET).toContain(ch);
      seen.add(c);
    }
    expect(seen.size).toBe(200); // ~40 bits each: a collision here means a broken RNG
  });

  it("matches a typed code however it is spaced or cased, and nothing else", () => {
    const code = "ABCD2345";
    const hash = hashChatLinkCode(code, COORD, A, W);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(code);
    expect(chatLinkCodeMatches("abcd-2345", hash, COORD, A, W)).toBe(true);
    expect(chatLinkCodeMatches(" ABCD 2345 ", hash, COORD, A, W)).toBe(true);
    expect(chatLinkCodeMatches("ABCD2346", hash, COORD, A, W)).toBe(false);
  });

  it("binds the hash to its link: same code, other account / key / event does not match", () => {
    const hash = hashChatLinkCode("ABCD2345", COORD, A, W);
    expect(chatLinkCodeMatches("ABCD2345", hash, COORD, "c".repeat(64), W)).toBe(false);
    expect(chatLinkCodeMatches("ABCD2345", hash, COORD, A, "c".repeat(64))).toBe(false);
    expect(chatLinkCodeMatches("ABCD2345", hash, COORD + "x", A, W)).toBe(false);
    // A cleared (closed) link's empty hash never matches anything.
    expect(chatLinkCodeMatches("ABCD2345", "", COORD, A, W)).toBe(false);
  });

  it("posts the instructions, then the code alone so it can be copied as-is", () => {
    expect(formatChatLinkCode("ABCD2345")).toBe("ABCD-2345");
    const [instructions, code] = chatLinkCodeMessages("ABCD2345", 30);
    expect(instructions).toContain("30 minutes");
    expect(instructions).toMatch(/Don't share it/);
    expect(instructions).not.toContain("ABCD");
    expect(code).toBe("ABCD2345");
  });
});
