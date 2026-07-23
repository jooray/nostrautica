/**
 * Reactive cache-hydration signal (audit §7.4.5). The persistent cache mirror
 * (`persist.ts`) is a plain synchronous Map: pages snapshot it once in their
 * `$state(cachedX())` initializers. Boot therefore used to AWAIT `hydrateAppCache`
 * before rendering any route, so the mirror was warm for those snapshots — up to
 * a 1.5 s wait on slow/broken IndexedDB.
 *
 * Instead the shell + route now render immediately and hydration runs in the
 * background. This signal bumps when hydration completes so cache-backed pages
 * can re-read the (now warm) mirror and paint from cache without gating boot.
 * `persist.ts` calls `cacheHydration.markHydrated()`; pages read
 * `cacheHydration.version` inside an `$effect` and re-run their cached read.
 */
class CacheHydration {
  /** Bumped once boot hydration finishes; pages watch it to re-read the mirror. */
  version = $state(0);
  done = $state(false);

  markHydrated(): void {
    this.done = true;
    this.version++;
  }

  /** Reset for a fresh boot/hydration cycle (e.g. owner change). */
  reset(): void {
    this.done = false;
  }
}

export const cacheHydration = new CacheHydration();
