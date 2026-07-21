<script lang="ts" generics="T">
  /**
   * Windowed list render (audit UX-30): a roster at spec scale (~200 people)
   * rendering every `PersonCard` at once is the biggest perf hit measured —
   * hundreds of avatar `<img>`s + DOM nodes on first paint, scroll jank on
   * mid-range phones. Only rows within the viewport (+ overscan) are mounted;
   * the rest is a single spacer div, so DOM node count stays flat regardless of
   * roster size.
   *
   * Deliberately window-scroll-based, not an inner `overflow:auto` pane —
   * the page keeps its normal scroll (search bar/filters/sort controls above
   * the roster scroll away too), matching how the page already behaved before
   * virtualization. Same document-relative-position technique as
   * `fill-height.ts`. Requires FIXED-height rows (PersonCard's are: single-line
   * name/line, no wrap) — a variable-height list would need real measurement.
   */
  import type { Snippet } from "svelte";
  import { onMount } from "svelte";
  import { virtualWindow } from "./virtual-list.js";

  let {
    items,
    itemHeight,
    getKey,
    overscan = 8,
    row,
  }: {
    items: T[];
    /** Row height in px (PersonCard ≈ 60: 40px avatar + 0.6rem vertical padding + border). */
    itemHeight: number;
    getKey: (item: T) => string;
    overscan?: number;
    row: Snippet<[T]>;
  } = $props();

  let container = $state<HTMLDivElement | undefined>();
  let containerTop = $state(0);
  let scrollY = $state(typeof window === "undefined" ? 0 : window.scrollY);
  let viewportHeight = $state(typeof window === "undefined" ? 0 : window.innerHeight);

  function measureTop(): void {
    if (!container) return;
    containerTop = container.getBoundingClientRect().top + window.scrollY;
  }
  function onScroll(): void {
    scrollY = window.scrollY;
  }
  function onResize(): void {
    viewportHeight = window.innerHeight;
    measureTop();
  }

  onMount(() => {
    measureTop();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    // Content ABOVE the roster (search results count, filter chips wrapping)
    // can shift the container's document position without a scroll/resize
    // event of their own — re-measure whenever the page's layout settles.
    const ro = new ResizeObserver(measureTop);
    ro.observe(document.body);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      ro.disconnect();
    };
  });

  const win = $derived(
    virtualWindow(items.length, itemHeight, scrollY - containerTop, viewportHeight, overscan),
  );
  const visibleItems = $derived(items.slice(win.startIndex, win.endIndex));
</script>

<div bind:this={container} style="position:relative; height:{win.totalHeight}px">
  <div style="position:absolute; top:{win.offsetTop}px; left:0; right:0">
    {#each visibleItems as item (getKey(item))}
      {@render row(item)}
    {/each}
  </div>
</div>
