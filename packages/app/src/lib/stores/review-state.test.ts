import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadReview,
  setReview,
  pubkeysInState,
  loadDismissedStatuses,
  saveDismissedStatuses,
  purgeLegacyGlobalReviewState,
} from "./review-state.js";
import { setActiveCacheOwner, __resetPersistForTests } from "$lib/cache/persist.js";

const COORD = "31923:eid:ev";
const A = "a".repeat(64);
const B = "b".repeat(64);
const OWNER1 = "1".repeat(64);
const OWNER2 = "2".repeat(64);

beforeEach(() => {
  __resetPersistForTests();
  setActiveCacheOwner(OWNER1); // an organizer is logged in
});

describe("review-state (UX-A7 reject/defer persistence)", () => {
  it("persists a rejection across a reload", () => {
    const m = setReview(COORD, loadReview(COORD), A, "rejected");
    expect(m[A]).toBe("rejected");
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
});

describe("review-state owner scoping (audit U11)", () => {
  it("does not leak one organizer's decisions to another account on the same device", () => {
    // Organizer 1 rejects A.
    setReview(COORD, loadReview(COORD), A, "rejected");
    // A second organizer signs in on the same device.
    setActiveCacheOwner(OWNER2);
    expect(loadReview(COORD)).toEqual({}); // sees nothing of organizer 1's
    // …and their own decision doesn't bleed back to organizer 1.
    setReview(COORD, loadReview(COORD), B, "deferred");
    setActiveCacheOwner(OWNER1);
    expect(loadReview(COORD)[A]).toBe("rejected");
    expect(loadReview(COORD)[B]).toBeUndefined();
  });

  it("scopes dismissed coordinator statuses per owner + event", () => {
    saveDismissedStatuses(COORD, ["s1", "s2"]);
    expect(loadDismissedStatuses(COORD)).toEqual(["s1", "s2"]);
    setActiveCacheOwner(OWNER2);
    expect(loadDismissedStatuses(COORD)).toEqual([]);
  });

  it("returns empty and no-ops when logged out (no active owner)", () => {
    setActiveCacheOwner(null);
    expect(loadReview(COORD)).toEqual({});
    expect(() => setReview(COORD, {}, A, "rejected")).not.toThrow();
    expect(loadReview(COORD)).toEqual({});
  });
});

describe("legacy global purge (audit U11)", () => {
  it("removes pre-U11 device-global localStorage entries", () => {
    const map = new Map<string, string>([
      ["nostrautica:review:31923:eid:ev", "{}"],
      ["nostrautica-coord-status-dismissed", "[]"],
      ["nostrautica:keep-me", "x"],
    ]);
    vi.stubGlobal("localStorage", {
      get length() {
        return map.size;
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    });
    purgeLegacyGlobalReviewState();
    expect(map.has("nostrautica:review:31923:eid:ev")).toBe(false);
    expect(map.has("nostrautica-coord-status-dismissed")).toBe(false);
    expect(map.has("nostrautica:keep-me")).toBe(true);
    vi.unstubAllGlobals();
  });
});
