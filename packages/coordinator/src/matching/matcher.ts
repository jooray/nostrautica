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

/** A usable embedding is a non-empty vector — `cosine` returns 0 for anything else. */
function hasEmbedding(a: AttendeeForMatching): boolean {
  return Array.isArray(a.embedding) && a.embedding.length > 0;
}

/**
 * All other pubkeys, or a prefiltered subset above the threshold (spec §9.3).
 *
 * `warn` defaults to console.warn rather than being required, because the one
 * thing this must never do again is fail silently — see the fallback below.
 */
export function candidatesFor(
  target: AttendeeForMatching,
  attendees: AttendeeForMatching[],
  cfg: PrefilterConfig,
  rng: () => number = Math.random,
  warn: (msg: string) => void = (m) => console.warn(m),
): string[] {
  const targetIndex = attendees.findIndex((a) => a.pubkey === target.pubkey);
  if (targetIndex < 0) return [];
  const others = attendees.filter((a) => a.pubkey !== target.pubkey);
  if (attendees.length <= cfg.threshold) {
    return others.map((a) => a.pubkey);
  }

  // Above the threshold the prefilter is the ONLY thing choosing who gets scored,
  // so it has to actually be able to rank (2026-09-04 audit). It passed
  // `a.embedding ?? []` straight through, and `cosine` returns 0 for an empty
  // vector — so with embeddings missing every similarity was 0, the sort was
  // stable, and "top-M by cosine similarity" silently degraded to "the first 30
  // attendees in roster order". Deterministic, unlogged, and worst at exactly the
  // events big enough to need the prefilter. It is not a hypothetical: the
  // coordinator's `attachEmbeddings` returns early when the embed role's provider
  // exposes no `embed()` at all, leaving the whole roster without vectors.
  //
  // The target's own vector is what everything is measured against, so without it
  // nothing can be ranked; a candidate without one can still be ranked past (it
  // simply sorts to the bottom, which is where an unknown belongs).
  const rankable = hasEmbedding(attendees[targetIndex]!) && others.some(hasEmbedding);
  if (!rankable) {
    // Random rather than roster order: it costs exactly the same number of LLM
    // calls as the prefilter it replaces, it is honest about not being a ranking,
    // and it does not systematically favour whoever joined first. Scoring everyone
    // would be the other defensible answer, but silently multiplying an event's
    // matching bill by five because a config knob is wrong is its own incident.
    const want = Math.min(cfg.topM + cfg.randomN, others.length);
    warn(
      `[match] prefilter has no usable embeddings for ${target.pubkey.slice(0, 8)} ` +
        `(roster ${attendees.length} > threshold ${cfg.threshold}) — cosine ranking is meaningless, ` +
        `falling back to ${want} RANDOM candidates. Check that models.embed points at a provider ` +
        `with an embeddings endpoint; matches will be materially worse until it does.`,
    );
    const pool = [...others];
    const picked: string[] = [];
    for (let k = 0; k < want; k++) {
      picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]!.pubkey);
    }
    return picked;
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
  /** "<provider>:<model>" for the `match` role, folded into the pair's inputs hash
   *  so switching the scoring model actually re-scores (audit PIPE-3). */
  matchModelKey = "",
  rng: () => number = Math.random,
  warn?: (msg: string) => void,
): CandidatePair[] {
  const hashByPubkey = new Map(attendees.map((a) => [a.pubkey, a.profileHash]));
  const candidatePubkeys = candidatesFor(target, attendees, cfg, rng, warn);
  const pairs: CandidatePair[] = [];
  for (const other of candidatePubkeys) {
    const otherHash = hashByPubkey.get(other);
    if (!otherHash) continue;
    const inputsHash = pairInputsHash(target.profileHash, otherHash, matchModelKey);
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
