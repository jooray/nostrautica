import { describe, it, expect } from "vitest";
import { paneHeight } from "./fill-height.js";

// The DOM half of the action (which observers fire when) needs a layout engine;
// what is testable here is the arithmetic it feeds, which is where the numbers
// from the 2026-09-12 report live.
describe("fill-height paneHeight", () => {
  const base = { viewportHeight: 791, top: 175, belowHeight: 71, gap: 96, min: 200 };

  it("leaves room for the composer and the nav band", () => {
    expect(paneHeight(base)).toBe(449);
  });

  it("gives back exactly what late content above the pane takes", () => {
    // The reported bug: a DM's "Also attending: …" line resolves ~a second after
    // the pane was sized and pushes it 33px down. Re-measured, the pane is 33px
    // shorter and the composer stays where it was; left stale, the composer moved
    // down those 33px — under a nav bar that starts 12px above its bottom edge.
    expect(paneHeight({ ...base, top: base.top + 33 })).toBe(paneHeight(base) - 33);
  });

  it("shrinks as the composer grows, so a growing textarea eats the transcript", () => {
    expect(paneHeight({ ...base, belowHeight: 128 })).toBe(392);
  });

  it("stops shrinking at min — a pane too short to read is worse than scrolling", () => {
    expect(paneHeight({ ...base, viewportHeight: 380 })).toBe(200);
    expect(paneHeight({ ...base, viewportHeight: 200, belowHeight: 300 })).toBe(200);
  });
});
