/**
 * Match confidence bands (redesign §4.2). Turns a raw 0–1 score into a
 * plain-language band so the UI leads with "Strong match" + a route glyph
 * instead of a bare percentage. Thresholds are the single tunable source.
 */
export type ConfidenceBand = "strong" | "good" | "hello";

export const STRONG_THRESHOLD = 0.8;
export const GOOD_THRESHOLD = 0.6;

export function confidenceBand(score: number): ConfidenceBand {
  if (!Number.isFinite(score)) return "hello"; // clamp NaN / ±∞
  if (score >= STRONG_THRESHOLD) return "strong";
  if (score >= GOOD_THRESHOLD) return "good";
  return "hello";
}
