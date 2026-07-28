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

  it("defaults sit below Home's 12s spinner backstop", () => {
    expect(SCAN_BUDGET_MS).toBeLessThan(12_000);
    expect(MAX_SIGNER_CALLS).toBeGreaterThan(0);
  });
});

describe("scanIncomplete", () => {
  it("is false for a pass that read everything it attempted", () => {
    expect(scanIncomplete({ attempted: 4, succeeded: 4, truncated: false })).toBe(false);
  });

  it("is false when SOME unwraps failed but the signer demonstrably answered", () => {
    // The steady state of any gift-wrap inbox: foreign/corrupt wraps addressed
    // to us that will never decrypt. Not an outage — must not raise an alarm.
    expect(scanIncomplete({ attempted: 10, succeeded: 1, truncated: false })).toBe(false);
  });

  it("is true when every signer round trip failed (an outage, not an empty account)", () => {
    expect(scanIncomplete({ attempted: 6, succeeded: 0, truncated: false })).toBe(true);
  });

  it("is true when the pass ran out of budget", () => {
    expect(scanIncomplete({ attempted: 50, succeeded: 50, truncated: true })).toBe(true);
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
        { attempted: 2, succeeded: 2, truncated: false },
        emptyOutcome(),
      ]),
    ).toBeNull();
  });

  it("prefers a real rejection over a synthetic incomplete", () => {
    const boom = new Error("relay pool is offline");
    expect(scanFailure([bad(boom), ok()], [{ attempted: 3, succeeded: 0, truncated: false }])).toBe(
      boom,
    );
  });

  it("reports an incomplete scan even though both promises resolved", () => {
    // This is the whole bug: `Promise.allSettled` said "fulfilled, fulfilled"
    // and Home concluded the account was empty.
    const failure = scanFailure([ok(), ok()], [
      emptyOutcome(),
      { attempted: 12, succeeded: 0, truncated: false },
    ]);
    expect(failure).toBeInstanceOf(ScanIncompleteError);
  });

  it("categorizes the synthetic failure as a timeout, not a generic error", async () => {
    const { categorizeError } = await import("$lib/nostr/errors.js");
    expect(categorizeError(new ScanIncompleteError(), { online: true })).toBe("timeout");
  });
});
