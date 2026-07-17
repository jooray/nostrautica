import { describe, it, expect } from "vitest";
import { selectCandidates, type PrefilterConfig } from "./prefilter.js";

// Deterministic RNG for reproducible random-slice tests.
function seededRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

describe("embedding prefilter (spec §9.3)", () => {
  it("below threshold, returns everyone (no prefilter)", () => {
    const embeddings = Array.from({ length: 5 }, (_, i) => [i, 0]);
    const cfg: PrefilterConfig = { threshold: 10, topM: 2, randomN: 1 };
    expect(selectCandidates(0, embeddings, cfg).sort()).toEqual([1, 2, 3, 4]);
  });

  it("above threshold, keeps top-M by cosine PLUS a random low-similarity slice", () => {
    // target = [1,0]; make 0 similar to a cluster and dissimilar to a tail.
    const embeddings = [
      [1, 0], // target (idx 0)
      [1, 0.01], // very similar
      [0.99, 0.02], // very similar
      [0.98, 0.03], // similar
      [0, 1], // orthogonal (low sim)
      [-1, 0.1], // opposite (low sim)
      [-0.9, 0.2], // opposite (low sim)
    ];
    const cfg: PrefilterConfig = { threshold: 3, topM: 2, randomN: 1 };
    const picked = selectCandidates(0, embeddings, cfg, seededRng(42));
    // top-2 by similarity are among {1,2,3}; plus exactly one from the low-sim tail {4,5,6}.
    expect(picked.length).toBe(3);
    const top = picked.slice(0, 2);
    expect(top.every((i) => [1, 2, 3].includes(i))).toBe(true);
    const randomPick = picked[2]!;
    // THE KEY PROPERTY: the random slice reaches a low-similarity candidate —
    // complementarity is what embeddings miss (the drummer must meet the bassist).
    expect([4, 5, 6]).toContain(randomPick);
  });

  it("never returns the target itself", () => {
    const embeddings = Array.from({ length: 60 }, (_, i) => [Math.cos(i), Math.sin(i)]);
    const cfg: PrefilterConfig = { threshold: 50, topM: 30, randomN: 10 };
    const picked = selectCandidates(5, embeddings, cfg, seededRng(1));
    expect(picked).not.toContain(5);
  });
});
