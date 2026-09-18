/**
 * Match confidence bands (redesign §4.2). Turns a match into a plain-language
 * band so the UI leads with "Strong match" + a route glyph instead of a bare
 * percentage.
 *
 * "Strong" is a PER-ATTENDEE cut, not a global one (2026-09-12). The bands used
 * to be two fixed thresholds on the raw score, which is what the badge is
 * supposed to mean — except the list it labels has already been truncated to the
 * top `top_k` by rank, and applying an absolute threshold to a rank-selected list
 * says "Strong match" about almost all of it. Measured on the Plan B event (1482
 * directed scores, 39 attendees with matches):
 *
 *   - across ALL pairs, 28% score ≥ 0.80 — the scorer is using its full range
 *   - across the top-20 each attendee is SHOWN, 51%
 *   - 30 of 39 attendees saw an all-strong top five
 *
 * So the compression was never in the prompt; it was here. docs/MATCHING-BENCHMARK.md
 * says as much in passing — "matches are selected by rank (`top_k`), not by an
 * absolute score floor" — and the model was tuned for separation and recall, i.e.
 * for ORDER. The badge quietly reread that ordinal signal as a calibrated absolute
 * claim it was never fitted to make.
 *
 * It is also a claim the score cannot support. A two-way decomposition of those
 * 1482 scores puts only 37% of the variance on the pair itself: 38% is a rater
 * effect (whose profile is the target — a broad, wordy profile scores everyone
 * high) and 26% a ratee effect. And the same pair scored in both directions lands
 * in a DIFFERENT band 233 times out of 741, with a mean gap of 0.11 against a
 * band 0.20 wide.
 *
 * Hence {@link STRONG_RANK}: strong means "one of your top few AND at least
 * {@link STRONG_FLOOR}". The rank half adapts to an attendee whose every score
 * runs hot or cold; the floor half is what keeps it honest, because a pure
 * per-attendee rescale would hand a "Strong match" to the one attendee here whose
 * best pair in the entire event is 0.60 — exactly the person for whom the true
 * answer ("nothing here is a sharp fit; your profile is thin") is the useful one.
 *
 * Below strong the threshold stays ABSOLUTE. Ranking the lower bands too was
 * tried and rejected: it printed "Worth a hello" on 154 pairs scoring ≥ 0.75,
 * which the expandable score breakdown in MatchDetails shows as a percentage
 * right underneath.
 */
export type ConfidenceBand = "strong" | "good" | "hello";

/** A match is never "strong" below this, however well it ranks for this attendee. */
export const STRONG_FLOOR = 0.75;
/** …nor unless it is among this many best (ties at the cut included). */
export const STRONG_RANK = 3;
/** Absolute floor for "good"; below it, "worth a hello". */
export const GOOD_THRESHOLD = 0.6;

/** The fields banding reads. A `Match` satisfies this; tests can pass literals. */
export interface BandableMatch {
  score: number;
  similarity?: number;
  complementarity?: number;
}

/** Non-finite scores (a misbehaving coordinator) sort last and band as "hello". */
function finite(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
}

/**
 * The score at or above which a match is "strong" FOR THIS ATTENDEE: their
 * STRONG_RANK-th best, but never under STRONG_FLOOR.
 *
 * Deliberately a threshold on the SCORE rather than a cut at an index, so two
 * matches with equal scores can never land in different bands — the scorer
 * quantizes hard (1482 production scores took just 19 distinct values, and the
 * average top-five holds only 2.46 of them), so ties at the cut are the common
 * case, not the edge case. A rank cut through one of those ties would badge two
 * identical numbers differently, which the score breakdown makes visible.
 *
 * That flatness is real and is not papered over here: an attendee with ten pairs
 * tied at 0.95 genuinely has ten best matches, and gets ten. Separating them is
 * the scorer's job (docs/MATCHING-BENCHMARK.md), not the badge's.
 */
export function strongCutFor(matches: readonly BandableMatch[]): number {
  if (matches.length === 0) return STRONG_FLOOR;
  const scores = matches.map((m) => finite(m.score)).sort((a, b) => b - a);
  const nth = scores[Math.min(STRONG_RANK, scores.length) - 1] ?? STRONG_FLOOR;
  return Math.max(STRONG_FLOOR, nth);
}

/**
 * Band one match against a cut from {@link strongCutFor} for the SAME list.
 * Splitting it this way keeps the per-list work out of the per-row render: the
 * caller derives the cut once and passes it down.
 */
export function bandAtCut(score: number, strongCut: number): ConfidenceBand {
  const s = finite(score);
  if (s >= strongCut) return "strong";
  if (s >= GOOD_THRESHOLD) return "good";
  return "hello";
}

/** Bands for a whole match list, in the same order. */
export function confidenceBands(matches: readonly BandableMatch[]): ConfidenceBand[] {
  const cut = strongCutFor(matches);
  return matches.map((m) => bandAtCut(m.score, cut));
}

/**
 * Rank order within an attendee's own list: score, then complementarity, then
 * similarity (2026-09-12).
 *
 * `buildMatchList` sorts on score alone, and at this scorer's granularity that
 * leaves 19 of 39 attendees with a TIED top match — whichever of them SQLite
 * happened to return first wins, and can change between recomputes. The two
 * dimensions already stored beside the score break half of those ties (tied #1s
 * 19 → 10, distinct keys in a top five 2.46 → 3.79), and complementarity is the
 * right first tie-break: the scoring prompt calls it "the most important signal".
 *
 * Applied client-side as well as in the coordinator, so an event scored before
 * that change — Plan B, among them — still orders correctly without a recompute.
 */
export function byMatchRank(a: BandableMatch, b: BandableMatch): number {
  return (
    finite(b.score) - finite(a.score) ||
    finite(b.complementarity) - finite(a.complementarity) ||
    finite(b.similarity) - finite(a.similarity)
  );
}
