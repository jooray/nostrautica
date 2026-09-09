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

/**
 * The crop must describe the box the user actually framed (audit MED-13).
 *
 * `ImageCropper` used a fixed `VIEW_W = 300` both to lay the viewport out and to
 * compute the crop, while `.viewport { max-width: 100% }` clamped the rendered
 * WIDTH and not the height. On a 320px phone the content box is about 251px, so
 * the user framed their photo in a 251×300 box and `confirm()` cropped a 300×300
 * one: they got roughly 50px down each side they never saw, and the pan maths
 * disagreed with the pointer by the same ratio.
 *
 * These pin the property the component now relies on — the geometry is a pure
 * function of the viewport it is handed, so measuring it is sufficient.
 */
describe("crop geometry follows the viewport it is given (MED-13)", () => {
  it("a narrower viewport crops a narrower region, not the nominal one", () => {
    // Same image, same scale, same offset: only the box the user sees differs.
    const wide = cropRect(0, 0, 1, 300, 300);
    const narrow = cropRect(0, 0, 1, 251, 300);
    expect(narrow.sw).toBeLessThan(wide.sw);
    expect(narrow.sw).toBeCloseTo(251, 5);
    expect(narrow.sh).toBeCloseTo(300, 5);
  });

  it("cover scale is computed against the real viewport too", () => {
    // A tall image is scaled to cover the box's WIDTH, so the nominal 300 magnified
    // it more than the 251 actually on screen — the other half of what shifted.
    expect(coverScale(100, 1000, 251, 300)).toBeLessThan(coverScale(100, 1000, 300, 300));
  });

  it("centring puts the image in the middle of the box actually rendered", () => {
    const { ox } = centerOffset(400, 400, 251, 300);
    expect(ox).toBeCloseTo((251 - 400) / 2, 5);
  });
});
