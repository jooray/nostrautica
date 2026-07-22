import { describe, it, expect } from "vitest";
import { dmPrefill } from "./dm-prefill.svelte.js";

describe("dmPrefill (Introduce us — §9.3)", () => {
  const peer = "a".repeat(64);

  it("takes a staged draft exactly once", () => {
    dmPrefill.set(peer, "You should meet — ask about zk proofs.");
    expect(dmPrefill.take(peer)).toBe("You should meet — ask about zk proofs.");
    // Consumed: a later manual visit starts blank.
    expect(dmPrefill.take(peer)).toBeUndefined();
  });

  it("returns undefined when nothing was staged", () => {
    expect(dmPrefill.take("b".repeat(64))).toBeUndefined();
  });

  it("overwrites a prior staged draft for the same peer", () => {
    dmPrefill.set(peer, "first");
    dmPrefill.set(peer, "second");
    expect(dmPrefill.take(peer)).toBe("second");
  });
});
