import { describe, it, expect } from "vitest";
import { Store } from "../store/db.js";
import { DEFAULT_PREFILTER } from "./prefilter.js";
import {
  selectPairsToScore,
  recordPairScore,
  buildMatchList,
  type AttendeeForMatching,
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
