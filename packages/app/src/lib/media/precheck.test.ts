import { describe, it, expect } from "vitest";
import { checkMediaLimits, MAX_UPLOAD_BYTES } from "./precheck.js";

describe("checkMediaLimits (audit U13)", () => {
  it("rejects a clip longer than the configured cap", () => {
    const v = checkMediaLimits({ sizeBytes: 1000, durationSec: 120, maxSec: 90 });
    expect(v).toEqual({ kind: "duration", limit: 90, actual: 120 });
  });

  it("accepts a clip at or under the cap", () => {
    expect(checkMediaLimits({ sizeBytes: 1000, durationSec: 90, maxSec: 90 })).toBeNull();
    expect(checkMediaLimits({ sizeBytes: 1000, durationSec: 30, maxSec: 90 })).toBeNull();
  });

  it("does not reject when the cap is unlimited (0)", () => {
    expect(checkMediaLimits({ sizeBytes: 1000, durationSec: 9999, maxSec: 0 })).toBeNull();
  });

  it("does not reject when duration is unknown (metadata failed to load)", () => {
    // 0 = unknown; defer to the authoritative server check rather than block.
    expect(checkMediaLimits({ sizeBytes: 1000, durationSec: 0, maxSec: 90 })).toBeNull();
  });

  it("rejects an obviously-too-large file on the size ceiling", () => {
    const v = checkMediaLimits({ sizeBytes: MAX_UPLOAD_BYTES + 1, durationSec: 10, maxSec: 90 });
    expect(v).toEqual({ kind: "size", limit: MAX_UPLOAD_BYTES, actual: MAX_UPLOAD_BYTES + 1 });
  });

  it("reports the duration violation before the size one", () => {
    const v = checkMediaLimits({
      sizeBytes: MAX_UPLOAD_BYTES + 1,
      durationSec: 120,
      maxSec: 90,
    });
    expect(v?.kind).toBe("duration");
  });
});
