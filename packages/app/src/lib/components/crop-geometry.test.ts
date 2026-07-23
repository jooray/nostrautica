import { describe, it, expect } from "vitest";
import {
  coverScale,
  clampOffset,
  centerOffset,
  panBy,
  cropRect,
  PAN_STEP,
} from "./crop-geometry.js";

describe("crop-geometry", () => {
  it("coverScale picks the larger ratio so the image always fills", () => {
    // Wide image into a square viewport → height is the binding constraint.
    expect(coverScale(400, 100, 300, 300)).toBe(3); // 300/100
    expect(coverScale(100, 400, 300, 300)).toBe(3); // 300/100
    expect(coverScale(0, 0, 300, 300)).toBe(1); // degenerate → 1
  });

  it("clampOffset keeps the image covering the viewport (no empty edges)", () => {
    // Image larger than viewport: offsets pinned between (viewW-dispW) and 0.
    expect(clampOffset(50, 50, 400, 400, 300, 300)).toEqual({ ox: 0, oy: 0 });
    expect(clampOffset(-999, -999, 400, 400, 300, 300)).toEqual({ ox: -100, oy: -100 });
    expect(clampOffset(-40, -40, 400, 400, 300, 300)).toEqual({ ox: -40, oy: -40 });
  });

  it("centerOffset centers the displayed image", () => {
    expect(centerOffset(400, 400, 300, 300)).toEqual({ ox: -50, oy: -50 });
  });

  it("panBy moves by PAN_STEP and stays clamped", () => {
    const at = { ox: -40, oy: -40 };
    const left = panBy("left", at.ox, at.oy, 400, 400, 300, 300);
    expect(left.ox).toBe(-40 + PAN_STEP);
    const right = panBy("right", at.ox, at.oy, 400, 400, 300, 300);
    expect(right.ox).toBe(-40 - PAN_STEP);
    // Clamps at the edge instead of exposing a gap.
    expect(panBy("left", -5, -5, 400, 400, 300, 300).ox).toBe(0);
    expect(panBy("right", -95, -95, 400, 400, 300, 300).ox).toBe(-100);
  });

  it("cropRect maps the viewport back into source pixels", () => {
    // scale 2, offset -50 → source starts at 25px, spans 150 source px.
    expect(cropRect(-50, -50, 2, 300, 300)).toEqual({ sx: 25, sy: 25, sw: 150, sh: 150 });
  });
});
