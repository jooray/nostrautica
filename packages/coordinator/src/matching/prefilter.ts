/**
 * Embedding prefilter (spec §9.3). Above a threshold (default 50 attendees) we
 * don't LLM-score all N−1 candidates per attendee. Instead we embed each profile
 * once and, per attendee, score the top-M by cosine similarity PLUS a random
 * sample of low-similarity candidates.
 *
 * The random slice is ESSENTIAL and must never be dropped: complementarity is
 * precisely what embedding similarity misses — the drummer must still meet the
 * bassist (IMPLEMENTATION_PLAN §3.10).
 */
import { cosine } from "./scoring.js";

export interface PrefilterConfig {
  threshold: number; // below this many attendees, score everyone
  topM: number; // top-M by cosine similarity
  randomN: number; // random low-similarity candidates
}

export const DEFAULT_PREFILTER: PrefilterConfig = {
  threshold: 50,
  topM: 30,
  randomN: 10,
};

/**
 * Select candidate indices to LLM-score for `targetIndex` against `embeddings`.
 * `rng` returns [0,1); inject a seeded generator in tests.
 */
export function selectCandidates(
  targetIndex: number,
  embeddings: number[][],
  cfg: PrefilterConfig,
  rng: () => number = Math.random,
): number[] {
  const n = embeddings.length;
  const others = [];
  for (let i = 0; i < n; i++) if (i !== targetIndex) others.push(i);

  // Below the threshold: score everyone (no prefilter).
  if (n <= cfg.threshold) return others;

  const target = embeddings[targetIndex]!;
  const scored = others
    .map((i) => ({ i, sim: cosine(target, embeddings[i]!) }))
    .sort((a, b) => b.sim - a.sim);

  const top = scored.slice(0, cfg.topM).map((s) => s.i);
  const topSet = new Set(top);

  // Random slice from the LOW-similarity tail (below top-M).
  const tail = scored.slice(cfg.topM).map((s) => s.i);
  const randomPicks: number[] = [];
  const tailCopy = [...tail];
  const want = Math.min(cfg.randomN, tailCopy.length);
  for (let k = 0; k < want; k++) {
    const idx = Math.floor(rng() * tailCopy.length);
    randomPicks.push(tailCopy.splice(idx, 1)[0]!);
  }

  return [...top, ...randomPicks.filter((i) => !topSet.has(i))];
}
