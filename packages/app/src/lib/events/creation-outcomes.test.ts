import { describe, it, expect } from "vitest";
import {
  buildReceipt,
  applyRetry,
  allSettled,
  failedSteps,
  type ReceiptInputs,
} from "./creation-outcomes.js";

function inputs(over: Partial<ReceiptInputs> = {}): ReceiptInputs {
  return {
    enrollAttempted: true,
    enrollFailed: false,
    coordinatorPicked: true,
    attachFailed: false,
    freshLocalKey: true,
    backupConfirmed: false,
    ...over,
  };
}

describe("creation receipt (UX-A3 tail)", () => {
  it("all-good creation: event ok, enrolled ok, grant ok, backup pending", () => {
    const r = buildReceipt(inputs());
    expect(r.eventPublished).toBe("ok");
    expect(r.organizerEnrolled).toBe("ok");
    expect(r.coordinatorGrant).toBe("ok");
    expect(r.keysBackedUp).toBe("pending");
    expect(allSettled(r)).toBe(true); // pending backup is not a failure
  });

  it("skips enrollment and coordinator when not requested", () => {
    const r = buildReceipt(inputs({ enrollAttempted: false, coordinatorPicked: false }));
    expect(r.organizerEnrolled).toBe("skipped");
    expect(r.coordinatorGrant).toBe("skipped");
  });

  it("remote signer reports keys already backed up", () => {
    expect(buildReceipt(inputs({ freshLocalKey: false })).keysBackedUp).toBe("ok");
  });

  it("§12.17 failed secondary setup surfaces as failed, and a successful retry resolves it", () => {
    // Both secondary steps failed at creation.
    let r = buildReceipt(inputs({ enrollFailed: true, attachFailed: true }));
    expect(r.organizerEnrolled).toBe("failed");
    expect(r.coordinatorGrant).toBe("failed");
    expect(allSettled(r)).toBe(false);
    expect(failedSteps(r).sort()).toEqual(["coordinatorGrant", "organizerEnrolled"].sort());

    // The organizer retries enrollment — it succeeds.
    r = applyRetry(r, "organizerEnrolled", true);
    expect(r.organizerEnrolled).toBe("ok");
    expect(allSettled(r)).toBe(false); // coordinator still failed

    // A retry that fails again keeps it failed (retryable, honest).
    r = applyRetry(r, "coordinatorGrant", false);
    expect(r.coordinatorGrant).toBe("failed");

    // A successful coordinator retry resolves the whole receipt.
    r = applyRetry(r, "coordinatorGrant", true);
    expect(r.coordinatorGrant).toBe("ok");
    expect(allSettled(r)).toBe(true);
    expect(failedSteps(r)).toEqual([]);
  });
});
