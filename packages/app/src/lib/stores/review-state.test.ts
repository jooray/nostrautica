import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadReview, setReview, pubkeysInState } from "./review-state.js";

beforeEach(() => {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
});

const COORD = "31923:eid:ev";
const A = "a".repeat(64);
const B = "b".repeat(64);

describe("review-state (UX-A7 reject/defer persistence)", () => {
  it("persists a rejection across a reload", () => {
    const m = setReview(COORD, loadReview(COORD), A, "rejected");
    expect(m[A]).toBe("rejected");
    // A fresh load (simulating reload) still has it.
    expect(loadReview(COORD)[A]).toBe("rejected");
  });

  it("tracks reject and defer independently and exposes them as sets", () => {
    let m = setReview(COORD, loadReview(COORD), A, "rejected");
    m = setReview(COORD, m, B, "deferred");
    expect([...pubkeysInState(m, "rejected")]).toEqual([A]);
    expect([...pubkeysInState(m, "deferred")]).toEqual([B]);
  });

  it("clears a review state (leaving it truly pending again)", () => {
    let m = setReview(COORD, loadReview(COORD), A, "rejected");
    m = setReview(COORD, m, A, undefined);
    expect(m[A]).toBeUndefined();
    expect(loadReview(COORD)[A]).toBeUndefined();
  });

  it("is per-event", () => {
    setReview(COORD, loadReview(COORD), A, "rejected");
    expect(loadReview("31923:eid:other")[A]).toBeUndefined();
  });

  it("survives storage failure without throwing", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    });
    expect(loadReview(COORD)).toEqual({});
    expect(() => setReview(COORD, {}, A, "rejected")).not.toThrow();
  });
});
