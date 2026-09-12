/**
 * Svelte action: let a textarea grow with what's typed into it, up to whatever
 * `max-height` the stylesheet sets (past that it scrolls, as before).
 *
 * Chat composers were fixed at their `rows` (2 in a DM, 1 in event chat), so a
 * message longer than that scrolled INSIDE the box: you could not see the
 * sentence you were writing, only the tail of it. That is a poor composer on its
 * own, and it was the visible half of the 2026-09-12 report — the DM composer
 * had also drifted under the fixed bottom nav (see `fill-height.ts`), so the
 * lines that scrolled out of view were the ones behind the nav bar.
 *
 * Growing the box is what makes the pane above it shrink: `fillHeight` observes
 * the composer, so the transcript gives up exactly the height the composer takes.
 *
 * Pass the bound value as the action argument (`use:autoGrow={draft}`) so the
 * box also re-measures when the text changes from code — a draft restored on
 * mount, a prefill from "message this person", the clear after a send.
 */

/**
 * The box-model arithmetic, split out so it can be tested without a layout
 * engine. `scrollHeight` covers content + padding but not borders, so what has
 * to be added back depends on which box `height` is being set on.
 */
export function growHeight(m: {
  scrollHeight: number;
  boxSizing: string;
  borderY: number;
  paddingY: number;
}): number {
  return m.boxSizing === "border-box"
    ? m.scrollHeight + m.borderY
    : Math.max(0, m.scrollHeight - m.paddingY);
}

export function autoGrow(node: HTMLTextAreaElement, _value?: unknown) {
  function measure(): void {
    // `auto` first: without it `scrollHeight` can never report less than the
    // height already set, so the box would grow and never shrink again.
    node.style.height = "auto";
    const cs = getComputedStyle(node);
    const px = (v: string) => parseFloat(v) || 0;
    node.style.height = `${growHeight({
      scrollHeight: node.scrollHeight,
      boxSizing: cs.boxSizing,
      borderY: px(cs.borderTopWidth) + px(cs.borderBottomWidth),
      paddingY: px(cs.paddingTop) + px(cs.paddingBottom),
    })}px`;
  }

  measure();
  node.addEventListener("input", measure);

  return {
    update() {
      measure();
    },
    destroy() {
      node.removeEventListener("input", measure);
      node.style.height = "";
    },
  };
}
