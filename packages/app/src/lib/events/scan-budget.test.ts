/**
 * The bounds and the vocabulary behind the 2026-07-28 "my events vanished"
 * report: a signer that never answers must be reportable as such, and neither
 * scan may walk an open-ended chain of remote-signer prompts.
 */
import { describe, it, expect } from "vitest";
import {
  startScanBudget,
  emptyOutcome,
  scanIncomplete,
  scanFailure,
  ScanIncompleteError,
  SCAN_BUDGET_MS,
  MAX_SIGNER_CALLS,
  LOW_PRIORITY_RESERVE,
} from "./scan-budget.js";

describe("startScanBudget", () => {
  it("stops handing out round trips at the call cap", () => {
    const budget = startScanBudget({ maxCalls: 3, now: () => 0 });
    expect([budget.take(), budget.take(), budget.take(), budget.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("stops handing out round trips once the wall clock is spent", () => {
    let clock = 1000;
    const budget = startScanBudget({ budgetMs: 500, now: () => clock });
    expect(budget.take()).toBe(true);
    clock += 499;
    expect(budget.take()).toBe(true);
    clock += 1; // exactly at the budget
    expect(budget.take()).toBe(false);
  });

  it("is shared: two scanners cannot between them spend twice the cap", () => {
    const budget = startScanBudget({ maxCalls: 2, now: () => 0 });
    expect(budget.take()).toBe(true); // scan A
    expect(budget.take()).toBe(true); // scan B
    expect(budget.take()).toBe(false); // A again — the pair is done
  });

  it("gives delayed scanners their own clock without replenishing the shared call cap", () => {
    let clock = 0;
    const shared = startScanBudget({ budgetMs: 100, maxCalls: 3, reserve: 1, now: () => clock });
    const membership = shared.fork();
    const grants = shared.fork();
    expect(membership.take("low")).toBe(true);
    clock = 16_000;
    expect(membership.take("low")).toBe(false);
    expect(grants.take()).toBe(true);
    expect(grants.take()).toBe(true);
    expect(shared.fork().take()).toBe(false);
  });

  it("keeps ONE scanner's decrypt window under Home's 12s spinner backstop", () => {
    // Deliberately no longer a claim about the whole ROUND: the clock starts at a
    // scanner's first claim, so relay reads ahead of it push the round past the
    // guard (see SCAN_BUDGET_MS). What survives is the part that still holds — a
    // scanner that gets going promptly reports "partial, retry" on its own rather
    // than being cut off mid-decrypt by the backstop.
    expect(SCAN_BUDGET_MS).toBeLessThan(12_000);
    expect(MAX_SIGNER_CALLS).toBeGreaterThan(0);
  });

  it("holds a reserve back from work that cannot recover a key", () => {
    // The membership sweep (31602 self-copies) proves you joined something; it
    // can never hand this device an ECK. Left to race for the same pool, an
    // account with many joins would spend the whole allowance on it and the
    // grant scan would run out before reaching the wrap that actually holds the
    // key the user is missing.
    const budget = startScanBudget({ maxCalls: 5, reserve: 3, now: () => 0 });
    expect([budget.take("low"), budget.take("low"), budget.take("low")]).toEqual([
      true,
      true,
      false, // only 5 − 3 claims are ever available to low-priority work
    ]);
    // …and the three it was refused are still there for the scans that count.
    expect([budget.take(), budget.take(), budget.take(), budget.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("lets normal work spend the whole pool, reserve included", () => {
    const budget = startScanBudget({ maxCalls: 2, reserve: 2, now: () => 0 });
    expect(budget.take("low")).toBe(false); // nothing at all is spare
    expect([budget.take(), budget.take(), budget.take()]).toEqual([true, true, false]);
  });

  it("defaults leave real room for both (the reserve is a floor, not the cap)", () => {
    expect(LOW_PRIORITY_RESERVE).toBeGreaterThan(0);
    expect(LOW_PRIORITY_RESERVE).toBeLessThan(MAX_SIGNER_CALLS);
  });

  it("a reserve wider than the cap disables low-priority work rather than wrapping", () => {
    const budget = startScanBudget({ maxCalls: 2, reserve: 99, now: () => 0 });
    expect(budget.take("low")).toBe(false);
    expect(budget.take()).toBe(true);
  });

  it("still stops low-priority work when the wall clock is spent", () => {
    let clock = 0;
    const budget = startScanBudget({ budgetMs: 100, maxCalls: 50, reserve: 0, now: () => clock });
    expect(budget.take("low")).toBe(true);
    clock += 100;
    expect(budget.take("low")).toBe(false);
  });
});

describe("scanIncomplete", () => {
  it("is false for a pass that read everything it attempted", () => {
    expect(scanIncomplete({ attempted: 4, succeeded: 4, truncated: false, unreachableEvents: 0 })).toBe(false);
  });

  it("is false when SOME unwraps failed but the signer demonstrably answered", () => {
    // The steady state of any gift-wrap inbox: foreign/corrupt wraps addressed
    // to us that will never decrypt. Not an outage — must not raise an alarm.
    expect(scanIncomplete({ attempted: 10, succeeded: 1, truncated: false, unreachableEvents: 0 })).toBe(false);
  });

  it("is true when every signer round trip failed (an outage, not an empty account)", () => {
    expect(scanIncomplete({ attempted: 6, succeeded: 0, truncated: false, unreachableEvents: 0 })).toBe(true);
  });

  it("is true when the pass ran out of budget", () => {
    expect(scanIncomplete({ attempted: 50, succeeded: 50, truncated: true, unreachableEvents: 0 })).toBe(true);
  });

  it("is false for a pass with nothing to do", () => {
    expect(scanIncomplete(emptyOutcome())).toBe(false);
  });
});

describe("scanFailure", () => {
  const ok = (v: unknown = []): PromiseSettledResult<unknown> => ({
    status: "fulfilled",
    value: v,
  });
  const bad = (reason: unknown): PromiseSettledResult<unknown> => ({
    status: "rejected",
    reason,
  });

  it("returns null when both scans came back complete", () => {
    expect(
      scanFailure([ok(), ok()], [
        { attempted: 2, succeeded: 2, truncated: false, unreachableEvents: 0 },
        emptyOutcome(),
      ]),
    ).toBeNull();
  });

  it("prefers a real rejection over a synthetic incomplete", () => {
    const boom = new Error("relay pool is offline");
    expect(scanFailure([bad(boom), ok()], [{ attempted: 3, succeeded: 0, truncated: false, unreachableEvents: 0 }])).toBe(
      boom,
    );
  });

  it("reports an incomplete scan even though both promises resolved", () => {
    // This is the whole bug: `Promise.allSettled` said "fulfilled, fulfilled"
    // and Home concluded the account was empty.
    const failure = scanFailure([ok(), ok()], [
      emptyOutcome(),
      { attempted: 12, succeeded: 0, truncated: false, unreachableEvents: 0 },
    ]);
    expect(failure).toBeInstanceOf(ScanIncompleteError);
  });

  it("categorizes the synthetic failure as a timeout, not a generic error", async () => {
    const { categorizeError } = await import("$lib/nostr/errors.js");
    expect(categorizeError(new ScanIncompleteError(), { online: true })).toBe("timeout");
  });
});
