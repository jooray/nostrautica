import { describe, it, expect, beforeEach, vi } from "vitest";
import { storeInvite, loadInvite, clearInvite } from "./invite-store.js";

// jsdom is not configured for these node unit tests; provide a minimal
// sessionStorage so the store's persistence path is exercised directly.
beforeEach(() => {
  const map = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
});

const COORD = "31923:eid:ev";
const NSEC = "nsec1exampleexampleexample";

describe("invite-store (UX-O2: invite survives reload)", () => {
  it("round-trips an invite code keyed by event coordinate", () => {
    storeInvite(COORD, NSEC);
    // A fresh load (simulating a reload) still finds the code.
    expect(loadInvite(COORD)).toBe(NSEC);
  });

  it("keys are per-event: another event's code is not returned", () => {
    storeInvite(COORD, NSEC);
    expect(loadInvite("31923:other:ev2")).toBeUndefined();
  });

  it("clears after a confirmed submission / cancel", () => {
    storeInvite(COORD, NSEC);
    clearInvite(COORD);
    expect(loadInvite(COORD)).toBeUndefined();
  });

  it("returns undefined when nothing is stored", () => {
    expect(loadInvite(COORD)).toBeUndefined();
  });

  it("survives a storage failure without throwing", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => storeInvite(COORD, NSEC)).not.toThrow();
    expect(loadInvite(COORD)).toBeUndefined();
    expect(() => clearInvite(COORD)).not.toThrow();
  });
});
