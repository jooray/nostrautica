import { describe, it, expect } from "vitest";
import {
  GOOD_THRESHOLD,
  STRONG_FLOOR,
  STRONG_RANK,
  bandAtCut,
  byMatchRank,
  confidenceBands,
  strongCutFor,
} from "./confidence.js";

/** Terse list builder: scores only, dimensions defaulted. */
const list = (...scores: number[]) =>
  scores.map((score) => ({ score, similarity: score, complementarity: score }));

describe("strongCutFor", () => {
  it("is the STRONG_RANK-th best score when that clears the floor", () => {
    expect(strongCutFor(list(0.95, 0.9, 0.85, 0.8, 0.75))).toBe(0.85);
  });
  it("never drops below the floor, however cold the whole list runs", () => {
    // The attendee whose best pair in the event is 0.60: a per-attendee rescale
    // would crown it "strong"; the floor is what refuses to.
    expect(strongCutFor(list(0.6, 0.6, 0.5, 0.45))).toBe(STRONG_FLOOR);
  });
  it("uses the last entry when the list is shorter than STRONG_RANK", () => {
    expect(strongCutFor(list(0.95, 0.9))).toBe(0.9);
    expect(strongCutFor(list(0.95))).toBe(0.95);
  });
  it("falls back to the floor for an empty list", () => {
    expect(strongCutFor([])).toBe(STRONG_FLOOR);
  });
  it("does not care what order it is handed the list in", () => {
    expect(strongCutFor(list(0.8, 0.95, 0.85, 0.9))).toBe(strongCutFor(list(0.95, 0.9, 0.85, 0.8)));
  });
});

describe("confidenceBands", () => {
  it("bands the top few strong and the rest by absolute score", () => {
    expect(confidenceBands(list(0.95, 0.9, 0.85, 0.8, 0.65, 0.5))).toEqual([
      "strong",
      "strong",
      "strong",
      "good",
      "good",
      "hello",
    ]);
  });

  it("gives equal scores equal bands, even across the rank cut", () => {
    // The production failure mode this rule exists for: the scorer quantizes to
    // 0.05, so the cut lands inside a tie far more often than not. Six pairs at
    // 0.95 are six best matches, not three-and-three.
    const bands = confidenceBands(list(0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.7));
    expect(bands.slice(0, 6)).toEqual(Array(6).fill("strong"));
    expect(bands[6]).toBe("good");
  });

  it("never prints a low band on a score the breakdown shows as high", () => {
    // MatchDetails discloses the raw percentages one tap away, so a 0.9 sitting
    // at rank 12 must not read "Worth a hello" beside "90 %".
    const bands = confidenceBands(list(...Array(15).fill(0.9)));
    expect(bands.every((b) => b === "strong")).toBe(true);
    const mixed = confidenceBands(list(0.95, 0.95, 0.95, 0.9, 0.9, 0.9));
    expect(mixed.slice(3)).toEqual(["good", "good", "good"]);
    expect(mixed).not.toContain("hello");
  });

  it("hands a cold list no strong match at all", () => {
    expect(confidenceBands(list(0.6, 0.55, 0.5))).toEqual(["good", "hello", "hello"]);
  });

  it("still bands a hot list, so nobody is left with an all-grey list", () => {
    expect(confidenceBands(list(0.75, 0.75, 0.7))).toEqual(["strong", "strong", "good"]);
  });

  it("clamps non-finite scores to hello", () => {
    const bands = confidenceBands([
      { score: 0.95 },
      { score: NaN },
      { score: Infinity },
      { score: -Infinity },
    ]);
    expect(bands[1]).toBe("hello");
    expect(bands[3]).toBe("hello");
    // +Infinity must not become the cut and demote a genuine 0.95.
    expect(bands[0]).toBe("strong");
  });
});

describe("bandAtCut", () => {
  it("splits on the cut and on GOOD_THRESHOLD", () => {
    expect(bandAtCut(0.9, 0.9)).toBe("strong");
    expect(bandAtCut(0.89, 0.9)).toBe("good");
    expect(bandAtCut(GOOD_THRESHOLD, 0.9)).toBe("good");
    expect(bandAtCut(GOOD_THRESHOLD - 0.01, 0.9)).toBe("hello");
  });
});

describe("byMatchRank", () => {
  it("orders by score, then complementarity, then similarity", () => {
    const rows = [
      { score: 0.85, complementarity: 0.7, similarity: 0.9 },
      { score: 0.85, complementarity: 0.9, similarity: 0.3 },
      { score: 0.9, complementarity: 0.1, similarity: 0.1 },
      { score: 0.85, complementarity: 0.7, similarity: 0.95 },
    ];
    expect([...rows].sort(byMatchRank)).toEqual([rows[2], rows[1], rows[3], rows[0]]);
  });

  it("sorts a match missing its dimensions below one that has them", () => {
    const withDims = { score: 0.8, complementarity: 0.5, similarity: 0.5 };
    const bare = { score: 0.8 };
    expect([bare, withDims].sort(byMatchRank)).toEqual([withDims, bare]);
  });

  it("is what separates the tied top the coordinator used to leave to SQLite", () => {
    const tied = [
      { score: 0.95, complementarity: 0.6, similarity: 0.95 },
      { score: 0.95, complementarity: 0.95, similarity: 0.6 },
    ];
    expect([...tied].sort(byMatchRank)[0]).toBe(tied[1]);
  });
});

describe("constants", () => {
  it("keeps the floor above the good threshold", () => {
    // A floor at or below GOOD_THRESHOLD would let "strong" and "good" collapse.
    expect(STRONG_FLOOR).toBeGreaterThan(GOOD_THRESHOLD);
    expect(STRONG_RANK).toBeGreaterThan(0);
  });
});
