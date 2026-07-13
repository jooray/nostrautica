import { describe, it, expect } from "vitest";
import { Store } from "../store/db.js";
import { DEFAULT_PREFILTER } from "./prefilter.js";
import {
  selectPairsToScore,
  recordPairScore,
  recordDirectedScore,
  groupIntoBatches,
  buildMatchList,
  type AttendeeForMatching,
  type CandidatePair,
} from "./matcher.js";
import { pairInputsHash } from "./scoring.js";

const coord = "31923:" + "a".repeat(64) + ":ev";

function attendee(pubkey: string, hash: string): AttendeeForMatching {
  return { pubkey, profileHash: hash };
}

describe("incremental matching (spec §9.3)", () => {
  it("a new joiner costs exactly N−1 new pairs", () => {
    const store = new Store();
    const roster = [
      attendee("a".repeat(64), "h1"),
      attendee("b".repeat(64), "h2"),
      attendee("c".repeat(64), "h3"),
      attendee("d".repeat(64), "h4"), // the 4th joiner
    ];
    const pairs = selectPairsToScore(store, coord, roster[3]!, roster, DEFAULT_PREFILTER);
    expect(pairs).toHaveLength(3); // d vs a, b, c
  });

  it("does not re-score an unchanged pair (restart never re-pays)", () => {
    const store = new Store();
    const roster = [attendee("a".repeat(64), "h1"), attendee("b".repeat(64), "h2")];
    const first = selectPairsToScore(store, coord, roster[0]!, roster, DEFAULT_PREFILTER);
    expect(first).toHaveLength(1);
    // Record the score, then re-select: the pair is cached with matching inputs_hash.
    recordPairScore(store, coord, first[0]!, {
      score: 0.9, similarity: 0.5, complementarity: 0.9, reasoningForA: "x", reasoningForB: "x",
    }, 1);
    const second = selectPairsToScore(store, coord, roster[0]!, roster, DEFAULT_PREFILTER);
    expect(second).toHaveLength(0);
  });

  it("a changed profile invalidates only its own pairs", () => {
    const store = new Store();
    let roster = [attendee("a".repeat(64), "h1"), attendee("b".repeat(64), "h2")];
    const pairs = selectPairsToScore(store, coord, roster[0]!, roster, DEFAULT_PREFILTER);
    recordPairScore(store, coord, pairs[0]!, { score: 1, similarity: 1, complementarity: 1, reasoningForA: "", reasoningForB: "" }, 1);
    // b changes its profile hash → the a–b pair must be re-scored.
    roster = [attendee("a".repeat(64), "h1"), attendee("b".repeat(64), "h2-changed")];
    const after = selectPairsToScore(store, coord, roster[0]!, roster, DEFAULT_PREFILTER);
    expect(after).toHaveLength(1);
    expect(after[0]!.inputsHash).toBe(pairInputsHash("h1", "h2-changed"));
  });

  it("builds a top-K match list sorted by score", () => {
    const store = new Store();
    const me = "a".repeat(64);
    for (const [pk, score] of [["b", 0.3], ["c", 0.9], ["d", 0.6]] as const) {
      store.putPair({
        coordinate: coord, a: me, b: pk.repeat(64), inputsHash: "x",
        score, similarity: score, complementarity: score, reasoningForA: `meet ${pk}`, reasoningForB: `meet ${pk}`, now: 1,
      });
    }
    const list = buildMatchList(store, coord, me, 2, 1000);
    expect(list.matches).toHaveLength(2);
    expect(list.matches[0]!.score).toBe(0.9);
    expect(list.matches[1]!.score).toBe(0.6);
  });
});

describe("batched grouping (spec §16.2, K=10)", () => {
  const mk = (a: string, b: string): CandidatePair => ({ a, b, inputsHash: `h:${a}:${b}` });

  it("splits one target's pairs into ≤K batches", () => {
    const pairs = Array.from({ length: 25 }, (_, i) => mk("T", `c${i}`));
    const batches = groupIntoBatches(pairs, 10);
    expect(batches.map((b) => b.length)).toEqual([10, 10, 5]);
    for (const batch of batches) expect(new Set(batch.map((p) => p.a)).size).toBe(1);
  });

  it("K boundary: fewer pending than K yields a single small batch", () => {
    expect(groupIntoBatches([mk("T", "c1"), mk("T", "c2")], 10)).toEqual([
      [mk("T", "c1"), mk("T", "c2")],
    ]);
    expect(groupIntoBatches([], 10)).toEqual([]);
  });

  it("never mixes targets in one batch", () => {
    const pairs = [mk("T1", "x"), mk("T2", "y"), mk("T1", "z")];
    const batches = groupIntoBatches(pairs, 10);
    expect(batches).toHaveLength(2);
    for (const batch of batches) expect(new Set(batch.map((p) => p.a)).size).toBe(1);
  });
});

describe("directional per-pair persistence (batched matcher)", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const hash = pairInputsHash("h1", "h2");
  const roster = [attendee(A, "h1"), attendee(B, "h2")];

  it("each direction persists independently; writing one never clobbers the other", () => {
    const store = new Store();
    recordDirectedScore(store, coord, { a: A, b: B, inputsHash: hash }, {
      score: 0.9, similarity: 0.4, complementarity: 0.95, reasoning: "You (A) should meet B.",
    }, 1);
    // Only A's direction is scored: A has a usable list entry, B does not yet.
    expect(buildMatchList(store, coord, A, 5, 10).matches).toHaveLength(1);
    expect(buildMatchList(store, coord, B, 5, 10).matches).toHaveLength(0);

    recordDirectedScore(store, coord, { a: B, b: A, inputsHash: hash }, {
      score: 0.7, similarity: 0.4, complementarity: 0.8, reasoning: "You (B) should meet A.",
    }, 2);
    const listA = buildMatchList(store, coord, A, 5, 10);
    const listB = buildMatchList(store, coord, B, 5, 10);
    // Each side sees its OWN directional score + reasoning.
    expect(listA.matches[0]!.score).toBe(0.9);
    expect(listA.matches[0]!.reasoning).toBe("You (A) should meet B.");
    expect(listB.matches[0]!.score).toBe(0.7);
    expect(listB.matches[0]!.reasoning).toBe("You (B) should meet A.");
    // Still one pair ROW (undirected cache keyed by inputs_hash).
    expect(store.getPair(coord, A, B)!.inputs_hash).toBe(hash);
  });

  it("a direction stays pending until scored, then dedupes; restart never re-pays", () => {
    const store = new Store();
    // B's direction scored first (B's own batch) — A's direction is still pending.
    recordDirectedScore(store, coord, { a: B, b: A, inputsHash: hash }, {
      score: 0.7, similarity: 0.4, complementarity: 0.8, reasoning: "You (B) should meet A.",
    }, 1);
    const pendingA = selectPairsToScore(store, coord, roster[0]!, roster, DEFAULT_PREFILTER);
    expect(pendingA).toEqual([{ a: A, b: B, inputsHash: hash }]);
    const pendingB = selectPairsToScore(store, coord, roster[1]!, roster, DEFAULT_PREFILTER);
    expect(pendingB).toHaveLength(0); // B's direction is done — never re-billed

    recordDirectedScore(store, coord, pendingA[0]!, {
      score: 0.9, similarity: 0.4, complementarity: 0.95, reasoning: "You (A) should meet B.",
    }, 2);
    expect(selectPairsToScore(store, coord, roster[0]!, roster, DEFAULT_PREFILTER)).toHaveLength(0);
  });

  it("a changed profile re-pends BOTH directions (stale row is dropped)", () => {
    const store = new Store();
    recordDirectedScore(store, coord, { a: A, b: B, inputsHash: hash }, {
      score: 0.9, similarity: 0.4, complementarity: 0.95, reasoning: "You (A) should meet B.",
    }, 1);
    recordDirectedScore(store, coord, { a: B, b: A, inputsHash: hash }, {
      score: 0.7, similarity: 0.4, complementarity: 0.8, reasoning: "You (B) should meet A.",
    }, 1);
    // B's profile changes → new inputs hash; scoring A→B resets the row so the
    // stale B→A reasoning is not served alongside fresh data.
    const newHash = pairInputsHash("h1", "h2-changed");
    const changed = [attendee(A, "h1"), attendee(B, "h2-changed")];
    expect(selectPairsToScore(store, coord, changed[0]!, changed, DEFAULT_PREFILTER)).toHaveLength(1);
    expect(selectPairsToScore(store, coord, changed[1]!, changed, DEFAULT_PREFILTER)).toHaveLength(1);
    recordDirectedScore(store, coord, { a: A, b: B, inputsHash: newHash }, {
      score: 0.5, similarity: 0.5, complementarity: 0.5, reasoning: "You (A): fresh take on B.",
    }, 2);
    expect(buildMatchList(store, coord, B, 5, 10).matches).toHaveLength(0); // stale B→A gone
    expect(selectPairsToScore(store, coord, changed[1]!, changed, DEFAULT_PREFILTER)).toHaveLength(1);
  });
});
