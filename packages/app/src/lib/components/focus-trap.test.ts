import { describe, it, expect } from "vitest";
import { nextTrapTarget } from "./focus-trap.js";

// nextTrapTarget is pure over an element list; use plain string stand-ins cast to
// the element type to exercise the wrap logic without a DOM.
function els(...names: string[]): HTMLElement[] {
  return names.map((n) => ({ name: n }) as unknown as HTMLElement);
}

describe("focus-trap nextTrapTarget", () => {
  const list = els("a", "b", "c");
  const [a, , c] = list;

  it("wraps forward from the last element to the first", () => {
    expect(nextTrapTarget(list, c, false)).toBe(a);
  });

  it("wraps backward from the first element to the last", () => {
    expect(nextTrapTarget(list, a, true)).toBe(c);
  });

  it("does not intervene mid-list (native Tab order is fine)", () => {
    expect(nextTrapTarget(list, list[1], false)).toBeNull();
    expect(nextTrapTarget(list, list[1], true)).toBeNull();
  });

  it("pulls focus back inside when it escaped the trapped set", () => {
    const outside = els("x")[0];
    expect(nextTrapTarget(list, outside, false)).toBe(a);
    expect(nextTrapTarget(list, outside, true)).toBe(c);
    expect(nextTrapTarget(list, null, false)).toBe(a);
  });

  it("returns null for an empty focusable set", () => {
    expect(nextTrapTarget([], null, false)).toBeNull();
  });
});
