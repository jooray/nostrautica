/**
 * "What's new" watermark math (spec §13): new-matches-since-last-visit and the
 * approval-since-last-visit signal.
 */
import { describe, it, expect } from "vitest";
import { newMatchPubkeys, newMatchCount, approvalIsNew, type Watermark } from "./whats-new.js";
import type { MatchListContent } from "@nostrautica/protocol";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function matches(...pks: string[]): MatchListContent {
  return {
    v: 2,
    computed_at: 1,
    matches: pks.map((pubkey) => ({ pubkey, score: 1, similarity: 1, complementarity: 1, reasoning: "" })),
  };
}
function wm(over: Partial<Watermark> = {}): Watermark {
  return { seenMatches: [], seenApproved: false, at: 0, ...over };
}

describe("newMatchPubkeys / newMatchCount", () => {
  it("counts matches whose pubkey wasn't seen last visit", () => {
    expect(newMatchPubkeys(matches(A, B, C), [A])).toEqual([B, C]);
    expect(newMatchCount(matches(A, B, C), wm({ seenMatches: [A] }))).toBe(2);
  });
  it("is zero when everything was already seen", () => {
    expect(newMatchCount(matches(A, B), wm({ seenMatches: [A, B] }))).toBe(0);
  });
  it("counts all matches on a first visit (nothing seen)", () => {
    expect(newMatchCount(matches(A, B), wm())).toBe(2);
  });
  it("undefined match list yields no new matches", () => {
    expect(newMatchCount(undefined, wm())).toBe(0);
  });
});

describe("approvalIsNew", () => {
  it("true when approved and not yet acknowledged", () => {
    expect(approvalIsNew(true, wm())).toBe(true);
  });
  it("false once acknowledged", () => {
    expect(approvalIsNew(true, wm({ seenApproved: true }))).toBe(false);
  });
  it("false when not approved", () => {
    expect(approvalIsNew(false, wm())).toBe(false);
  });
});
