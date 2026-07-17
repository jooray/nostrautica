import { describe, it, expect } from "vitest";
import { confidenceBand } from "./confidence.js";

describe("confidenceBand", () => {
  it("≥ 0.80 → strong", () => {
    expect(confidenceBand(0.8)).toBe("strong");
    expect(confidenceBand(0.87)).toBe("strong");
    expect(confidenceBand(1)).toBe("strong");
  });
  it("[0.60, 0.80) → good", () => {
    expect(confidenceBand(0.6)).toBe("good");
    expect(confidenceBand(0.79)).toBe("good");
  });
  it("< 0.60 → hello", () => {
    expect(confidenceBand(0.59)).toBe("hello");
    expect(confidenceBand(0)).toBe("hello");
    expect(confidenceBand(-1)).toBe("hello");
  });
  it("clamps non-finite to hello", () => {
    expect(confidenceBand(NaN)).toBe("hello");
    expect(confidenceBand(Infinity)).toBe("hello");
    expect(confidenceBand(-Infinity)).toBe("hello");
  });
});
