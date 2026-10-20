import { describe, it, expect } from "vitest";
import { reseed } from "./form-seed.js";

describe("reseed (audit SB-17)", () => {
  it("takes the data on the first seed", () => {
    expect(reseed("off", undefined, "on")).toBe("on");
  });

  it("follows the data while the field is untouched", () => {
    expect(reseed("off", "off", "prerecord-first")).toBe("prerecord-first");
  });

  it("keeps an unsaved edit when another card's save replaces the data", () => {
    // Seeded "off", user picked "on", the retention save re-published with talks still "off".
    expect(reseed("on", "off", "off")).toBe("on");
  });

  it("supports a null value as a real seed (empty retention)", () => {
    expect(reseed<number | null>(null, null, 30)).toBe(30);
    expect(reseed<number | null>(14, null, null)).toBe(14);
  });
});
