/**
 * Pure windowing math for `VirtualList.svelte` (audit UX-30: a 200-attendee
 * roster rendering all rows at once is the biggest perf hit at scale). Fixed
 * row height (the roster's rows are single-line, non-wrapping — see
 * PersonCard.svelte — so this holds exactly; a caller with variable-height
 * rows would need real measurement instead).
 *
 * Split out from the component so the range math is testable without a DOM.
 */
export interface VirtualWindow {
  /** First index to render (inclusive). */
  startIndex: number;
  /** Last index to render (exclusive). */
  endIndex: number;
  /** Pixels to translate the rendered window down by. */
  offsetTop: number;
  /** Total scrollable height if every row were rendered. */
  totalHeight: number;
}

/**
 * `relativeScroll` is how far the viewport's top has scrolled PAST the list
 * container's own top (0 or negative when the container hasn't reached the
 * top of the viewport yet). Clamped defensively — a negative/zero result still
 * renders a valid (near-empty-offset) window rather than going out of bounds.
 */
export function virtualWindow(
  itemCount: number,
  itemHeight: number,
  relativeScroll: number,
  viewportHeight: number,
  overscan: number,
): VirtualWindow {
  const totalHeight = itemCount * itemHeight;
  if (itemCount === 0 || itemHeight <= 0) {
    return { startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight };
  }
  const scroll = Math.max(0, relativeScroll);
  const endIndex = Math.min(
    itemCount,
    Math.ceil((scroll + Math.max(0, viewportHeight)) / itemHeight) + overscan,
  );
  // Clamped to endIndex too, not just 0: a scroll position stale from before a
  // filter shrank the list (e.g. `items` drops from 200 to 10 mid-scroll) must
  // not leave startIndex past the end — that would slice() to nothing and put
  // the (empty) window at a bogus offset far below the real content.
  const startIndex = Math.min(endIndex, Math.max(0, Math.floor(scroll / itemHeight) - overscan));
  return { startIndex, endIndex, offsetTop: startIndex * itemHeight, totalHeight };
}
