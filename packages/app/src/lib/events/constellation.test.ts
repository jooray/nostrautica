import { describe, it, expect } from "vitest";
import { eventConstellation } from "./constellation.js";

describe("eventConstellation", () => {
  const seeds = ["abc", "deadbeef", "0".repeat(64), "cypherpunk-congress"];

  it("is deterministic for a seed", () => {
    for (const s of seeds) {
      expect(eventConstellation(s)).toEqual(eventConstellation(s));
    }
  });

  it("has 4–6 points, sorted by x, within bounds", () => {
    for (const s of seeds) {
      const c = eventConstellation(s);
      expect(c.points.length).toBeGreaterThanOrEqual(4);
      expect(c.points.length).toBeLessThanOrEqual(6);
      let prevX = -Infinity;
      for (const p of c.points) {
        expect(p.x).toBeGreaterThanOrEqual(20);
        expect(p.x).toBeLessThanOrEqual(280);
        expect(p.y).toBeGreaterThanOrEqual(25);
        expect(p.y).toBeLessThanOrEqual(95);
        expect(p.r).toBeGreaterThanOrEqual(2);
        expect(p.r).toBeLessThanOrEqual(3.2);
        expect(p.x).toBeGreaterThanOrEqual(prevX); // sorted
        prevX = p.x;
      }
    }
  });

  it("path begins with a moveto and joins every point", () => {
    const c = eventConstellation("abc");
    expect(c.path.startsWith("M")).toBe(true);
    // one M + (n-1) L commands
    expect((c.path.match(/[ML]/g) ?? []).length).toBe(c.points.length);
  });

  it("distinct seeds usually differ", () => {
    expect(eventConstellation("alice")).not.toEqual(eventConstellation("bob"));
  });
});
