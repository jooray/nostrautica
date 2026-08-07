/**
 * Offline event pack (spec §13): the completeness marker. The fetch
 * orchestration itself rides the real cache layer (exercised in e2e); this
 * covers the pure derivation the UI relies on. Byte formatting moved to
 * `util/bytes.test.ts` along with the formatter.
 */
import { describe, it, expect } from "vitest";
import { packComplete, type OfflinePack } from "./offline-pack.js";

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
