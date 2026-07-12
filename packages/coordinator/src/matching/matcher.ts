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
} from "./scoring.js";
import { selectCandidates, type PrefilterConfig } from "./prefilter.js";

export interface AttendeeForMatching {
  pubkey: string;
  profileHash: string;
  embedding?: number[];
}

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
    const cached = store.getPair(coordinate, target.pubkey, other);
    if (!cached || cached.inputs_hash !== inputsHash) {
      pairs.push({ a: target.pubkey, b: other, inputsHash });
    }
  }
  return pairs;
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
    reasoning: score.reasoning,
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
    }));
  return { v: 1, computed_at: now, matches };
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
