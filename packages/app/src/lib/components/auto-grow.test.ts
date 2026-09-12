import { describe, it, expect } from "vitest";
import { growHeight } from "./auto-grow.js";

// `scrollHeight` is content + padding, so the height that reproduces it depends
// on which box `height` sizes. The app is border-box throughout; content-box is
// covered so the action stays correct if a composer is ever styled differently.
describe("auto-grow growHeight", () => {
  it("adds the borders back under border-box", () => {
    expect(growHeight({ scrollHeight: 90, boxSizing: "border-box", borderY: 2, paddingY: 21 })).toBe(92);
  });

  it("subtracts the padding under content-box", () => {
    expect(growHeight({ scrollHeight: 90, boxSizing: "content-box", borderY: 2, paddingY: 21 })).toBe(69);
  });

  it("never asks for a negative height", () => {
    expect(growHeight({ scrollHeight: 10, boxSizing: "content-box", borderY: 0, paddingY: 40 })).toBe(0);
  });
});
