/**
 * Svelte action: size a scroll pane to the height actually left on screen.
 *
 * Chat panes want the classic messenger shape — the transcript takes whatever
 * vertical space is going, the composer sits directly under it, and neither the
 * transcript growing nor a long backlog pushes the composer off the bottom. A
 * fixed `50dvh` can't do that: it leaves dead space under the composer on a tall
 * window and squeezes the transcript on a short one.
 *
 * The pane's own top offset is only knowable at runtime (it depends on the
 * page's header, the shell's compact event header, disclosure text that wraps
 * differently per locale …), so measure it: height = viewport − pane top −
 * whatever must stay visible underneath.
 *
 * Recomputed on window/visual-viewport resize (covers rotation, the mobile
 * keyboard, and desktop window drags) and whenever the reserved element itself
 * changes size (a growing textarea). Deliberately NOT observing the pane or the
 * body — writing the pane's height would re-trigger such an observer.
 */
export interface FillHeightOptions {
  /** Element that must stay visible below the pane (the composer). */
  below?: HTMLElement | null;
  /**
   * Extra pixels to keep free under `below` — the fixed bottom nav plus a
   * breathing gap. Defaults to the shell's 5rem nav allowance + 1rem.
   */
  gap?: number;
  /** Never shrink below this (a pane too short to read is worse than scrolling). */
  min?: number;
}

export function fillHeight(node: HTMLElement, options: FillHeightOptions = {}) {
  let opts = options;
  let applied = -1;

  function apply(): void {
    const gap = opts.gap ?? 96;
    const min = opts.min ?? 200;
    // Document-relative top, so a scrolled page measures the same as an unscrolled one.
    const top = node.getBoundingClientRect().top + window.scrollY;
    const reserve = (opts.below?.offsetHeight ?? 0) + gap;
    const height = Math.max(min, Math.round(window.innerHeight - top - reserve));
    if (Math.abs(height - applied) < 2) return; // no-op writes cause observer churn
    applied = height;
    node.style.height = `${height}px`;
  }

  apply();
  // The pane's top can settle a frame late (fonts, images, the compact header).
  const raf = requestAnimationFrame(apply);

  window.addEventListener("resize", apply);
  window.visualViewport?.addEventListener("resize", apply);
  const ro = new ResizeObserver(apply);
  if (opts.below) ro.observe(opts.below);

  return {
    update(next: FillHeightOptions) {
      const prevBelow = opts.below;
      opts = next;
      if (next.below !== prevBelow) {
        ro.disconnect();
        if (next.below) ro.observe(next.below);
      }
      apply();
    },
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", apply);
      window.visualViewport?.removeEventListener("resize", apply);
      ro.disconnect();
    },
  };
}
