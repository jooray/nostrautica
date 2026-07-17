/**
 * Perf instrumentation for the measurement phase (CACHING-PLAN §1.3). Zero UI.
 *
 * Each cache-first page calls `perfMark(page, "cache-paint")` once when the
 * first meaningful data is set (cache OR network, whichever wins) and
 * `perfMark(page, "network-settled")` once the background refresh settles. The
 * delta is measured from the last route change (recorded by the router/layout
 * via `markRouteChange`). Marks land in `window.__nostrauticaPerf` — the e2e
 * measurement agent reads that array.
 */

export type PerfPhase = "cache-paint" | "network-settled";

export interface PerfMark {
  page: string;
  phase: PerfPhase;
  ms: number;
  at: number;
}

declare global {
  interface Window {
    __nostrauticaPerf?: PerfMark[];
  }
}

let routeChangedAt = 0;

/** Called on every route change so page deltas are measured from navigation. */
export function markRouteChange(): void {
  if (typeof performance === "undefined") return;
  routeChangedAt = performance.now();
}

/**
 * Record a phase for a page. Deduped per (page, phase) since the last route
 * change, so a page that re-renders doesn't spam duplicate cache-paint marks.
 */
const seen = new Set<string>();
let seenRouteAt = -1;

export function perfMark(page: string, phase: PerfPhase): void {
  if (typeof performance === "undefined" || typeof window === "undefined") return;
  // Reset the per-route dedupe set when the route changed.
  if (seenRouteAt !== routeChangedAt) {
    seen.clear();
    seenRouteAt = routeChangedAt;
  }
  const dedupeKey = `${page}:${phase}`;
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);

  const now = performance.now();
  const mark: PerfMark = {
    page,
    phase,
    ms: routeChangedAt ? Math.round(now - routeChangedAt) : 0,
    at: Date.now(),
  };
  (window.__nostrauticaPerf ??= []).push(mark);
  console.debug(`[perf] ${page} ${phase} +${mark.ms}ms`);
}
