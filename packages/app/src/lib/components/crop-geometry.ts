/**
 * Pure crop/pan geometry for ImageCropper (audit §7.3.2). Extracted so the
 * pan-clamp and keyboard-step maths are unit-testable without a DOM/canvas — the
 * component keeps only the wiring (pointer/keyboard events, canvas draw).
 */

/** "Cover" scale: smallest scale at which the image fills the viewport. */
export function coverScale(
  imgW: number,
  imgH: number,
  viewW: number,
  viewH: number,
): number {
  if (imgW <= 0 || imgH <= 0) return 1;
  return Math.max(viewW / imgW, viewH / imgH);
}

/** Clamp the image top-left offset so the image always covers the viewport. */
export function clampOffset(
  ox: number,
  oy: number,
  dispW: number,
  dispH: number,
  viewW: number,
  viewH: number,
): { ox: number; oy: number } {
  return {
    ox: Math.min(0, Math.max(viewW - dispW, ox)),
    oy: Math.min(0, Math.max(viewH - dispH, oy)),
  };
}

/** Offset that centers the image within the viewport. */
export function centerOffset(
  dispW: number,
  dispH: number,
  viewW: number,
  viewH: number,
): { ox: number; oy: number } {
  return { ox: (viewW - dispW) / 2, oy: (viewH - dispH) / 2 };
}

/** Pixels to move per arrow-key press (keyboard panning). */
export const PAN_STEP = 16;

/**
 * Apply a keyboard pan in the given direction, clamped. Directions match arrow
 * keys: ArrowLeft moves the VIEW left (image right), etc.
 */
export function panBy(
  dir: "left" | "right" | "up" | "down",
  ox: number,
  oy: number,
  dispW: number,
  dispH: number,
  viewW: number,
  viewH: number,
  step = PAN_STEP,
): { ox: number; oy: number } {
  let nx = ox;
  let ny = oy;
  if (dir === "left") nx += step;
  else if (dir === "right") nx -= step;
  else if (dir === "up") ny += step;
  else if (dir === "down") ny -= step;
  return clampOffset(nx, ny, dispW, dispH, viewW, viewH);
}

/**
 * Map the viewport region back into source-image pixel space for canvas draw:
 * the sx/sy/sw/sh a `drawImage` needs to render exactly what the user framed.
 */
export function cropRect(
  ox: number,
  oy: number,
  scale: number,
  viewW: number,
  viewH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  return { sx: -ox / scale, sy: -oy / scale, sw: viewW / scale, sh: viewH / scale };
}
