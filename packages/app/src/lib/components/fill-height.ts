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
 * keyboard, and desktop window drags), whenever the reserved element itself
 * changes size (a growing textarea), and — the 2026-09-12 fix — whenever
 * anything laid out ABOVE the pane changes, because that moves the pane's top
 * without changing anything this action was previously watching. A DM thread
 * renders "Also attending: …" only once `listEventKeys` + the roster check
 * resolve, i.e. a few hundred ms after the pane was already sized; that one
 * 33px line pushed the pane, and with it the composer, straight down under the
 * fixed bottom nav, so the second line of anything you typed was invisible
 * (user report with a screenshot, 2026-09-12).
 *
 * Watching for that means observing the ancestor chain: an auto-height ancestor
 * grows when content appears inside it above the pane. `document.body` alone is
 * not enough — it carries `min-height: 100dvh`, so on a page that fits the
 * viewport (exactly the case here, since this action is what makes it fit) its
 * box never changes at all.
 *
 * Writing the pane's height does re-trigger those observers — that's why the
 * original deliberately observed nothing but the composer. It's harmless now:
 * callbacks are coalesced into one rAF, and the recompute that follows a write
 * measures the same numbers and writes nothing (`applied`), so a change settles
 * in two passes instead of looping.
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

/**
 * The arithmetic, split out so it can be tested without a layout engine.
 * All inputs are CSS pixels; `top` is document-relative.
 */
export function paneHeight(input: {
  viewportHeight: number;
  top: number;
  belowHeight: number;
  gap: number;
  min: number;
}): number {
  const { viewportHeight, top, belowHeight, gap, min } = input;
  return Math.max(min, Math.round(viewportHeight - top - belowHeight - gap));
}

export function fillHeight(node: HTMLElement, options: FillHeightOptions = {}) {
  let opts = options;
  let applied = -1;
  let frame = 0;

  function apply(): void {
    frame = 0;
    // Document-relative top, so a scrolled page measures the same as an unscrolled one.
    const top = node.getBoundingClientRect().top + window.scrollY;
    const height = paneHeight({
      viewportHeight: window.innerHeight,
      top,
      belowHeight: opts.below?.offsetHeight ?? 0,
      gap: opts.gap ?? 96,
      min: opts.min ?? 200,
    });
    if (Math.abs(height - applied) < 2) return; // no-op writes cause observer churn
    applied = height;
    node.style.height = `${height}px`;
  }

  /** Coalesce a burst (resize + several observer callbacks) into one measurement. */
  function schedule(): void {
    if (frame) return;
    frame = requestAnimationFrame(apply);
  }

  apply();
  // The pane's top can settle a frame late (fonts, images, the compact header).
  schedule();

  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);

  /** The composer: its height is subtracted, so its own growth must re-measure. */
  const belowRo = new ResizeObserver(schedule);
  if (opts.below) belowRo.observe(opts.below);

  /** Ancestors: content appearing above the pane moves its top (see above). */
  const flowRo = new ResizeObserver(schedule);
  for (let p = node.parentElement; p; p = p.parentElement) flowRo.observe(p);

  return {
    update(next: FillHeightOptions) {
      const prevBelow = opts.below;
      opts = next;
      if (next.below !== prevBelow) {
        belowRo.disconnect();
        if (next.below) belowRo.observe(next.below);
      }
      apply();
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      belowRo.disconnect();
      flowRo.disconnect();
    },
  };
}
