/**
 * Deterministic event "constellation route" for the event header (redesign §4.3).
 * A handful of points seeded from the event pubkey, joined left-to-right into a
 * route — the nautica motif (people are points, the event is a route to steer
 * by). Same event always draws the same shape. Pure, no DOM.
 */
import { sha256Hex, utf8ToBytes } from "@nostrautica/protocol";

export interface Constellation {
  points: { x: number; y: number; r: number }[];
  /** Polyline joining the points in x order, for the 300×120 viewBox. */
  path: string;
}

export function eventConstellation(seed: string): Constellation {
  const hash = sha256Hex(utf8ToBytes(seed || "event")); // 64 hex chars (32 bytes)
  const byte = (i: number): number => {
    const at = (i * 2) % 64;
    return parseInt(hash.slice(at, at + 2), 16);
  };
  const count = 4 + (byte(0) % 3); // 4, 5 or 6 points
  const points: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < count; i++) {
    const bx = byte(i * 3 + 1);
    const by = byte(i * 3 + 2);
    const br = byte(i * 3 + 3);
    points.push({
      x: 20 + (bx / 255) * 260, // 20–280
      y: 25 + (by / 255) * 70, // 25–95
      r: 2 + (br / 255) * 1.2, // 2–3.2
    });
  }
  points.sort((a, b) => a.x - b.x);
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
  return { points, path };
}
