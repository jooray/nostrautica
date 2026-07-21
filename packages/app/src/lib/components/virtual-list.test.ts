import { describe, it, expect } from "vitest";
import { virtualWindow } from "./virtual-list.js";

describe("virtualWindow (audit UX-30)", () => {
  it("at the top of an unscrolled list, renders only the visible rows + overscan", () => {
    const w = virtualWindow(200, 60, 0, 800, 4);
    expect(w.startIndex).toBe(0); // clamped — no rows above index 0
    // visible rows ≈ ceil(800/60) = 14, + 4 overscan below = 18
    expect(w.endIndex).toBe(18);
    expect(w.offsetTop).toBe(0);
    expect(w.totalHeight).toBe(200 * 60);
  });

  it("scrolled partway down, the window slides and gains a top offset", () => {
    // Scrolled 600px into the list.
    const w = virtualWindow(200, 60, 600, 800, 4);
    expect(w.startIndex).toBe(Math.floor(600 / 60) - 4); // 10 - 4 = 6
    expect(w.offsetTop).toBe(6 * 60);
    expect(w.endIndex).toBeGreaterThan(w.startIndex);
  });

  it("never renders past the end of the list", () => {
    const w = virtualWindow(10, 60, 10_000, 800, 4);
    expect(w.endIndex).toBe(10);
    expect(w.startIndex).toBeLessThanOrEqual(10);
  });

  it("a scroll position stale from before a filter shrank the list doesn't produce a bogus window", () => {
    // Scrolled 5000px in when the list had 200 rows; a filter just cut it to 10.
    const w = virtualWindow(10, 60, 5000, 800, 4);
    expect(w.startIndex).toBeLessThanOrEqual(w.endIndex);
    expect(w.endIndex).toBe(10);
    expect(w.offsetTop).toBeLessThanOrEqual(w.totalHeight);
  });

  it("a negative relativeScroll (container hasn't reached viewport top yet) clamps to the start", () => {
    const w = virtualWindow(200, 60, -500, 800, 4);
    expect(w.startIndex).toBe(0);
    expect(w.offsetTop).toBe(0);
  });

  it("an empty list renders nothing and has zero total height", () => {
    const w = virtualWindow(0, 60, 0, 800, 4);
    expect(w).toEqual({ startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight: 0 });
  });

  it("the whole short list renders when it's shorter than the viewport", () => {
    const w = virtualWindow(5, 60, 0, 800, 4);
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(5); // clamped to itemCount, not the raw viewport math
  });

  it("total height scales with item count regardless of scroll position", () => {
    expect(virtualWindow(50, 60, 0, 800, 4).totalHeight).toBe(3000);
    expect(virtualWindow(50, 60, 1000, 800, 4).totalHeight).toBe(3000);
  });
});
