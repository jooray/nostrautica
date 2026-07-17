import { describe, it, expect } from "vitest";
import { avatarHues, avatarGradient, initialsFor } from "./avatar.js";

/** Relative luminance of an sRGB colour (WCAG 2.x). */
function relLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** hsl(h s% l%) → [r,g,b] 0–255. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function contrastWithWhite(r: number, g: number, b: number): number {
  const l = relLuminance(r, g, b);
  return 1.05 / (l + 0.05);
}

describe("avatarHues", () => {
  it("is deterministic for a seed", () => {
    expect(avatarHues("deadbeef")).toEqual(avatarHues("deadbeef"));
  });
  it("hues are within 0–360", () => {
    for (const seed of ["a", "bb", "cypherpunk", "0".repeat(64)]) {
      const [h1, h2] = avatarHues(seed);
      expect(h1).toBeGreaterThanOrEqual(0);
      expect(h1).toBeLessThan(360);
      expect(h2).toBeGreaterThanOrEqual(0);
      expect(h2).toBeLessThan(360);
    }
  });
  it("distinct seeds usually differ", () => {
    expect(avatarHues("alice")).not.toEqual(avatarHues("bob"));
  });
});

describe("avatarGradient white-text contrast (both stops, every hue)", () => {
  it("passes 4.5:1 against white across the full wheel", () => {
    // Both gradient stops: hsl(h 55% 29%) and hsl(h2 50% 24%).
    for (let h = 0; h < 360; h += 1) {
      const light = hslToRgb(h, 55, 29);
      const dark = hslToRgb(h, 50, 24);
      expect(contrastWithWhite(...light)).toBeGreaterThanOrEqual(4.5);
      expect(contrastWithWhite(...dark)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("emits a linear-gradient string", () => {
    expect(avatarGradient("abc")).toMatch(/^linear-gradient\(135deg, hsl\(/);
  });
});

describe("initialsFor", () => {
  it("two words → first grapheme of each", () => {
    expect(initialsFor("Šimon Koska")).toBe("ŠK");
    expect(initialsFor("Ada Lovelace")).toBe("AL");
  });
  it("single word → first two graphemes", () => {
    expect(initialsFor("sats")).toBe("SA");
    expect(initialsFor("x")).toBe("X");
  });
  it("no name → first two chars of npub body", () => {
    expect(initialsFor(undefined, "npub1s4abc")).toBe("S4");
    expect(initialsFor("", "npub1q0xyz")).toBe("Q0");
  });
  it("nothing → placeholder", () => {
    expect(initialsFor()).toBe("?");
  });
});
