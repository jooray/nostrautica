import { describe, it, expect } from "vitest";
import { compareLatest, supersedes, pickLatest, revisionSupersedes } from "./ordering.js";

describe("latest-event rule (NIP §3.1)", () => {
  it("higher created_at wins", () => {
    const a = { id: "ff", created_at: 100 };
    const b = { id: "00", created_at: 99 };
    expect(pickLatest([a, b])).toBe(a);
    expect(pickLatest([b, a])).toBe(a);
    expect(supersedes(a, b)).toBe(true);
    expect(supersedes(b, a)).toBe(false);
  });

  it("on a created_at tie, the lexicographically LOWEST id wins (not the highest)", () => {
    const low = { id: "0000", created_at: 100 };
    const high = { id: "ffff", created_at: 100 };
    // Both arrival orders converge on the same winner (the low id).
    expect(pickLatest([low, high])).toBe(low);
    expect(pickLatest([high, low])).toBe(low);
    expect(supersedes(low, high)).toBe(true);
    expect(supersedes(high, low)).toBe(false);
  });

  it("tie-break is deterministic regardless of arrival order across many events", () => {
    const ids = ["c3", "a1", "b2", "9f", "d4"];
    const events = ids.map((id) => ({ id, created_at: 500 }));
    const forward = pickLatest(events);
    const reversed = pickLatest([...events].reverse());
    expect(forward).toBe(reversed);
    expect(forward!.id).toBe("9f"); // lexicographically smallest
  });

  it("a re-delivery of the same event does not supersede itself", () => {
    const e = { id: "abcd", created_at: 100 };
    expect(supersedes({ ...e }, e)).toBe(false);
    expect(compareLatest({ ...e }, e)).toBe(0);
  });

  it("treats a missing created_at as 0", () => {
    const withTime = { id: "ff", created_at: 1 };
    const without = { id: "00" };
    expect(pickLatest([without, withTime])).toBe(withTime);
  });

  it("pickLatest returns undefined for an empty list", () => {
    expect(pickLatest([])).toBeUndefined();
  });

  it("a per-d dedupe map converges no matter the arrival order (fetch vs stream parity)", () => {
    // Model both readers: fold events into a map keyed by d, replacing when the
    // incoming event supersedes the stored one. fetch (batch) and stream
    // (incremental, any order) must land on the same winner — the bug v2 fixes is
    // that they used `>` vs `>=` and disagreed on ties.
    const fold = (arrival: { id: string; created_at: number }[]) => {
      const byD = new Map<string, { id: string; created_at: number }>();
      for (const e of arrival) {
        const prev = byD.get("d");
        if (!prev || supersedes(e, prev)) byD.set("d", e);
      }
      return byD.get("d")!.id;
    };
    const evs = [
      { id: "e2", created_at: 100 },
      { id: "e1", created_at: 100 }, // same second, lower id → must win
      { id: "e3", created_at: 99 },
    ];
    expect(fold(evs)).toBe("e1");
    expect(fold([...evs].reverse())).toBe("e1");
    expect(fold([evs[1]!, evs[0]!, evs[2]!])).toBe("e1");
  });
});

describe("revisioned submission order (NIP §3.3)", () => {
  const cur = { rev: 5, created_at: 100, id: "m" };
  // The six permutations of (rev, created_at, id) around the stored key.
  it("higher rev supersedes (even with older created_at / higher id)", () => {
    expect(revisionSupersedes({ rev: 6, created_at: 1, id: "z" }, cur)).toBe(true);
  });
  it("lower rev never supersedes (even with newer created_at / lower id)", () => {
    expect(revisionSupersedes({ rev: 4, created_at: 999, id: "0" }, cur)).toBe(false);
  });
  it("equal rev, higher created_at supersedes", () => {
    expect(revisionSupersedes({ rev: 5, created_at: 101, id: "z" }, cur)).toBe(true);
  });
  it("equal rev, lower created_at does not supersede", () => {
    expect(revisionSupersedes({ rev: 5, created_at: 99, id: "0" }, cur)).toBe(false);
  });
  it("equal rev+created_at, lower id supersedes", () => {
    expect(revisionSupersedes({ rev: 5, created_at: 100, id: "a" }, cur)).toBe(true);
  });
  it("equal rev+created_at, higher id does not supersede", () => {
    expect(revisionSupersedes({ rev: 5, created_at: 100, id: "z" }, cur)).toBe(false);
  });
  it("an exactly-equal key does not supersede (idempotent re-delivery is a no-op)", () => {
    expect(revisionSupersedes({ ...cur }, cur)).toBe(false);
  });
  it("both arrival orders of two competing keys converge on the same winner", () => {
    const a = { rev: 5, created_at: 100, id: "a" };
    const b = { rev: 5, created_at: 100, id: "b" };
    const fold = (arrival: typeof a[]) => {
      let best = arrival[0]!;
      for (const k of arrival.slice(1)) if (revisionSupersedes(k, best)) best = k;
      return best.id;
    };
    expect(fold([a, b])).toBe("a");
    expect(fold([b, a])).toBe("a");
  });
});
