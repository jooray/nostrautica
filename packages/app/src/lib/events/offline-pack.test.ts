/**
 * Offline event pack (spec §13): completeness marker + byte formatting. The
 * fetch orchestration itself rides the real cache layer (exercised in e2e); this
 * covers the pure derivations the UI relies on.
 */
import { describe, it, expect } from "vitest";
import { packComplete, formatBytes, type OfflinePack } from "./offline-pack.js";

function pack(steps: OfflinePack["steps"]): OfflinePack {
  return { at: 1, steps, mediaSkipped: true };
}

describe("packComplete", () => {
  it("is complete when every applicable step succeeded", () => {
    expect(
      packComplete(
        pack([
          { key: "roster", ok: true, count: 3 },
          { key: "directory", ok: true, count: 3 },
        ]),
      ),
    ).toBe(true);
  });

  it("skipped steps (no coordinator / talks off) do not block completeness", () => {
    expect(
      packComplete(
        pack([
          { key: "roster", ok: true, count: 3 },
          { key: "matches", ok: true, count: 0, skipped: true },
          { key: "talks", ok: true, count: 0, skipped: true },
        ]),
      ),
    ).toBe(true);
  });

  it("a failed step marks the pack incomplete", () => {
    expect(
      packComplete(
        pack([
          { key: "roster", ok: true, count: 3 },
          { key: "directory", ok: false, count: 0 },
        ]),
      ),
    ).toBe(false);
  });

  it("is incomplete when no service worker controlled the build (R7)", () => {
    // Every data step succeeded, but without a controller the app SCREENS can't
    // have cached — the pack must not claim offline-readiness.
    expect(
      packComplete({
        at: 1,
        mediaSkipped: true,
        swControlled: false,
        steps: [{ key: "roster", ok: true, count: 3 }],
      }),
    ).toBe(false);
  });

  it("is complete when a controller was present and every step succeeded (R7)", () => {
    expect(
      packComplete({
        at: 1,
        mediaSkipped: true,
        swControlled: true,
        steps: [
          { key: "shell", ok: true, count: 5 },
          { key: "modules", ok: true, count: 6 },
          { key: "roster", ok: true, count: 3 },
        ],
      }),
    ).toBe(true);
  });
});

describe("formatBytes", () => {
  it("scales units and handles zero", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1000)).toBe("1.0 KB");
    expect(formatBytes(5_000_000)).toBe("5.0 MB");
    expect(formatBytes(150_000_000)).toBe("150 MB");
  });

  it("uses decimal units, so a labelled GB is 10^9 bytes and not a GiB", () => {
    // Regression: this divided by 1024 while labelling the output "KB/MB/GB",
    // so every figure read ~7% low by the GB step.
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1_000_000_000)).toBe("1.0 GB");
    expect(formatBytes(9_999_999_999)).toBe("10.0 GB");
  });
});
