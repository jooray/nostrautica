/**
 * Ordering for the intro reuse gallery (spec §6.2).
 *
 * Its own module rather than a closure inside Record.svelte so the rule is
 * testable without a browser — and so the test covers the code that actually
 * runs, instead of a copy of it that drifts.
 *
 * The gallery used to render the library in stored order (oldest first) and
 * showed no dates, so four clips looked interchangeable and the only way to find
 * the latest was to watch them (reported 2026-09-13). Stored order has always
 * been chronological — `addToLibrary` appends — so reversing it answers "which
 * is the most recent" even for clips recorded before there was a timestamp to
 * show.
 */
export function orderForGallery<T extends { x: string }>(
  items: readonly T[],
  at: Record<string, number>,
): T[] {
  return items
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const av = at[a.m.x];
      const bv = at[b.m.x];
      // Both stamped: newest first. Otherwise stored order, reversed — a stamped
      // clip is not "newer" than an unstamped one merely for having a number, so
      // position still decides between them.
      if (av !== undefined && bv !== undefined) return bv - av;
      return b.i - a.i;
    })
    .map((e) => e.m);
}
