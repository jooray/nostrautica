/**
 * Matching orchestration (spec §9.3). Turns "attendee X's profile changed" into a
 * minimal set of pair-scoring jobs and, once scored, per-attendee top-K match
 * lists.
 *
 * Incremental: a new joiner costs exactly N−1 new pairs; a changed profile
 * invalidates only its own pairs (pairs are keyed by inputs_hash, so unchanged
 * pairs are never re-scored → a restart never re-pays for finished pairs).
 */
import type { Match, MatchListContent } from "@nostrautica/protocol";
import type { Store } from "../store/db.js";
import {
  pairInputsHash,
  type PairScore,
  type DirectedScore,
} from "./scoring.js";
import { selectCandidates, type PrefilterConfig } from "./prefilter.js";

export interface AttendeeForMatching {
  pubkey: string;
  profileHash: string;
  embedding?: number[];
}

/**
 * A DIRECTED pair to score: `a` is the target, `b` the candidate. The batched
 * matcher produces the a→b reasoning (addressed to a); the b→a direction is a
 * separate CandidatePair produced when b is the target of its own recompute.
 */
export interface CandidatePair {
  a: string;
  b: string;
  inputsHash: string;
}

/** All other pubkeys, or a prefiltered subset above the threshold (spec §9.3). */
export function candidatesFor(
  target: AttendeeForMatching,
  attendees: AttendeeForMatching[],
  cfg: PrefilterConfig,
  rng: () => number = Math.random,
): string[] {
  const targetIndex = attendees.findIndex((a) => a.pubkey === target.pubkey);
  if (targetIndex < 0) return [];
  if (attendees.length <= cfg.threshold) {
    return attendees.filter((a) => a.pubkey !== target.pubkey).map((a) => a.pubkey);
  }
  const embeddings = attendees.map((a) => a.embedding ?? []);
  const idxs = selectCandidates(targetIndex, embeddings, cfg, rng);
  return idxs.map((i) => attendees[i]!.pubkey);
}

/**
 * Pairs that need (re)scoring for `target` against the roster: candidate pairs
 * whose cached inputs_hash differs from the current one (new or changed only).
 */
export function selectPairsToScore(
  store: Store,
  coordinate: string,
  target: AttendeeForMatching,
  attendees: AttendeeForMatching[],
  cfg: PrefilterConfig,
  rng: () => number = Math.random,
): CandidatePair[] {
  const hashByPubkey = new Map(attendees.map((a) => [a.pubkey, a.profileHash]));
  const candidatePubkeys = candidatesFor(target, attendees, cfg, rng);
  const pairs: CandidatePair[] = [];
  for (const other of candidatePubkeys) {
    const otherHash = hashByPubkey.get(other);
    if (!otherHash) continue;
    const inputsHash = pairInputsHash(target.profileHash, otherHash);
    // Directional idempotency: the target→other direction is pending unless a row
    // exists for the current inputs_hash AND that direction has been scored (its
    // reasoning is non-empty). A row seeded by the reverse (other→target) batch
    // still leaves this direction to do.
    const dir = store.getPairDirection(coordinate, target.pubkey, other);
    if (!dir || dir.inputs_hash !== inputsHash || !dir.scored) {
      pairs.push({ a: target.pubkey, b: other, inputsHash });
    }
  }
  return pairs;
}

/**
 * Split directed pairs into batches of at most `batchSize`. All pairs share the
 * same target `a` (they come from one target's recompute), so a batch is one
 * target + ≤K candidates — exactly the batched call shape. If a caller ever mixes
 * targets, we still group by target defensively so each batch is single-target.
 */
export function groupIntoBatches(pairs: CandidatePair[], batchSize: number): CandidatePair[][] {
  const byTarget = new Map<string, CandidatePair[]>();
  for (const p of pairs) {
    const list = byTarget.get(p.a) ?? [];
    list.push(p);
    byTarget.set(p.a, list);
  }
  const batches: CandidatePair[][] = [];
  for (const list of byTarget.values()) {
    for (let i = 0; i < list.length; i += batchSize) {
      batches.push(list.slice(i, i + batchSize));
    }
  }
  return batches;
}

/** Persist ONE directed score (a→b), addressed to a. Preserves the b→a direction. */
export function recordDirectedScore(
  store: Store,
  coordinate: string,
  pair: CandidatePair,
  score: DirectedScore,
  now: number,
): void {
  store.putPairDirection({
    coordinate,
    from: pair.a,
    to: pair.b,
    inputsHash: pair.inputsHash,
    score: score.score,
    similarity: score.similarity,
    complementarity: score.complementarity,
    reasoning: score.reasoning,
    ...(score.icebreakers ? { icebreakers: score.icebreakers } : {}),
    now,
  });
}

/** Persist a computed pair score into the cache. */
export function recordPairScore(
  store: Store,
  coordinate: string,
  pair: CandidatePair,
  score: PairScore,
  now: number,
): void {
  store.putPair({
    coordinate,
    a: pair.a,
    b: pair.b,
    inputsHash: pair.inputsHash,
    score: score.score,
    similarity: score.similarity,
    complementarity: score.complementarity,
    reasoningForA: score.reasoningForA,
    reasoningForB: score.reasoningForB,
    now,
  });
}

/** Build an attendee's top-K match list (kind 31605 content) from cached pairs. */
export function buildMatchList(
  store: Store,
  coordinate: string,
  pubkey: string,
  topK: number,
  now: number,
): MatchListContent {
  const rows = store.pairsFor(coordinate, pubkey);
  const matches: Match[] = rows
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((r) => ({
      pubkey: r.other,
      score: r.score,
      similarity: r.similarity,
      complementarity: r.complementarity,
      reasoning: r.reasoning,
      ...(r.icebreakers && r.icebreakers.length > 0 ? { icebreakers: r.icebreakers } : {}),
    }));
  return { v: 2, computed_at: now, matches };
}

/** Pubkeys whose match list must be republished after scoring these pairs. */
export function affectedByPairs(pairs: CandidatePair[]): string[] {
  const set = new Set<string>();
  for (const p of pairs) {
    set.add(p.a);
    set.add(p.b);
  }
  return [...set];
}
