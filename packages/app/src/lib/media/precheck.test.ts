import { describe, it, expect } from "vitest";
import { checkMediaLimits, normalizeDurationSec, MAX_UPLOAD_BYTES } from "./precheck.js";

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

  it("treats a non-finite duration as unknown, never as a violation", () => {
    // A MediaRecorder WebM reports `Infinity` for HTMLMediaElement.duration until
    // a seek forces the browser to measure it. Before this, the caller's
    // `Math.round(el.duration) || 0` passed Infinity straight through and the
    // user was told "that clip is Infinity s — the limit is 90 s".
    expect(
      checkMediaLimits({ sizeBytes: 1000, durationSec: Number.POSITIVE_INFINITY, maxSec: 90 }),
    ).toBeNull();
    expect(checkMediaLimits({ sizeBytes: 1000, durationSec: Number.NaN, maxSec: 90 })).toBeNull();
    // …but the SIZE ceiling still applies with an unknown duration.
    expect(
      checkMediaLimits({
        sizeBytes: MAX_UPLOAD_BYTES + 1,
        durationSec: Number.POSITIVE_INFINITY,
        maxSec: 90,
      })?.kind,
    ).toBe("size");
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

describe("normalizeDurationSec", () => {
  it("rounds a real duration to whole seconds", () => {
    expect(normalizeDurationSec(12.4)).toBe(12);
    expect(normalizeDurationSec(12.6)).toBe(13);
  });

  it("reports 0 (unknown) for every value a media element can hand back that isn't one", () => {
    // Infinity: a MediaRecorder WebM before a seek-to-end forces measurement.
    expect(normalizeDurationSec(Number.POSITIVE_INFINITY)).toBe(0);
    // NaN: metadata not loaded yet.
    expect(normalizeDurationSec(Number.NaN)).toBe(0);
    expect(normalizeDurationSec(0)).toBe(0);
    expect(normalizeDurationSec(-3)).toBe(0);
    expect(normalizeDurationSec(undefined)).toBe(0);
    expect(normalizeDurationSec(null)).toBe(0);
  });

  it("is what `Math.round(x) || 0` is not: Infinity-safe", () => {
    // The exact expression this replaces, kept as executable evidence.
    expect(Math.round(Number.POSITIVE_INFINITY) || 0).toBe(Number.POSITIVE_INFINITY);
    expect(normalizeDurationSec(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
