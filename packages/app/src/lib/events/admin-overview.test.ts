import { describe, it, expect } from "vitest";
import { buildOverview, type OverviewInput } from "./admin-overview.js";

function input(over: Partial<OverviewInput> = {}): OverviewInput {
  return {
    pendingCount: 0,
    approvedCount: 10,
    missingIntros: 0,
    failedJobs: 0,
    talksAwaiting: 0,
    matchesAvailable: true,
    hasCoordinator: true,
    coordinatorStale: false,
    coordinatorUnknown: false,
    billingBlocked: false,
    ...over,
  };
}

describe("buildOverview (UX-A5)", () => {
  it("healthy event: no exceptions, metrics present", () => {
    const { exceptions, metrics } = buildOverview(input());
    expect(exceptions).toEqual([]);
    expect(metrics.map((m) => m.id)).toContain("pending");
    expect(metrics.map((m) => m.id)).toContain("approved");
  });

  it("surfaces failed jobs, billing, and stale coordinator as exceptions", () => {
    const { exceptions } = buildOverview(
      input({ failedJobs: 3, billingBlocked: true, coordinatorStale: true }),
    );
    expect(exceptions.map((m) => m.id).sort()).toEqual(["billing", "coordinator", "failedJobs"].sort());
    expect(exceptions.every((m) => m.tone === "warn")).toBe(true);
  });

  it("does not double-count coordinator when stale (only the exception, not the healthy metric)", () => {
    const { exceptions, metrics } = buildOverview(input({ coordinatorStale: true }));
    expect(exceptions.some((m) => m.id === "coordinator")).toBe(true);
    expect(metrics.some((m) => m.id === "coordinator")).toBe(false);
  });

  it("omits coordinator/talks/matches metrics when no coordinator is attached", () => {
    const { metrics } = buildOverview(input({ hasCoordinator: false, billingBlocked: true, coordinatorStale: true }));
    const ids = metrics.map((m) => m.id);
    expect(ids).not.toContain("coordinator");
    expect(ids).not.toContain("talksAwaiting");
    expect(ids).not.toContain("matches");
    // Billing/coordinator exceptions are also gated on hasCoordinator.
    expect(buildOverview(input({ hasCoordinator: false, billingBlocked: true })).exceptions).toEqual([]);
  });

  it("pending count reads as a warn tone when there is a queue", () => {
    const { metrics } = buildOverview(input({ pendingCount: 4 }));
    expect(metrics.find((m) => m.id === "pending")?.tone).toBe("warn");
  });
});
