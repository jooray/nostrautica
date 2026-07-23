/**
 * Draft-safe automatic refresh (App-2). The global PWA mandate is that a new
 * deploy applies WITHOUT the user ever doing a manual hard refresh — but the old
 * pwa.ts reloaded the instant a new service worker took control, which would
 * wipe a half-typed post, an in-progress recording, or an unsaved settings edit.
 *
 * This guard reconciles the two: components mark themselves "dirty" while they
 * hold unsaved work (a live recording, non-empty compose/create/settings text);
 * when a new worker takes control the reload is DEFERRED while anything is dirty
 * and then applied automatically the moment the last dirty holder clears — no
 * click, no manual refresh. Drafts are additionally persisted (see `drafts.ts`)
 * so nothing is lost even across the eventual reload.
 *
 * It is a plain rune singleton so both `pwa.ts` (which requests the refresh) and
 * the shell banner (which shows "update will apply when you're done") can read
 * it, and any component can `hold()` a reason inside an `$effect`.
 */

class RefreshGuard {
  /**
   * Refcount per reason so overlapping holders (e.g. two compose boxes) nest.
   *
   * This is a PLAIN, non-reactive Map on purpose (App-2 incident 2026-07-23):
   * every `hold()` call site runs INSIDE a component `$effect` reacting to form
   * state (Create title, Record dirty, compose text…). If `hold()`/`release()`
   * mutated `$state` that the guard also reads back on the same tick, Svelte 5
   * flags the effect as reading-and-writing its own dependency and throws
   * `effect_update_depth_exceeded` — which wedged the page the instant a tracked
   * field became non-empty (Create's success screen never rendered even though
   * the event published). The dirty registry therefore carries NO reactive
   * state; the only value that needs reactivity is `pending`, read by the shell
   * banner, and nothing reads `dirty` reactively.
   */
  private refs = new Map<string, number>();
  /** The deferred reload, captured when a worker took control while dirty. */
  private refresh: (() => void) | null = null;
  private pending = $state(false);

  /** True while any unsaved work is held — the reload waits on this going false. */
  get dirty(): boolean {
    for (const n of this.refs.values()) if (n > 0) return true;
    return false;
  }

  /** True once a new version is ready but is waiting for dirty work to finish. */
  get updateWaiting(): boolean {
    return this.pending;
  }

  /**
   * Hold the guard dirty under `reason`; returns a release fn (idempotent). Call
   * from a component `$effect` and return the releaser so it clears on unmount /
   * when the work is no longer dirty:
   *
   *   $effect(() => { if (draft.trim()) return refreshGuard.hold("dm"); });
   */
  hold(reason: string): () => void {
    this.refs.set(reason, (this.refs.get(reason) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.refs.get(reason) ?? 1) - 1;
      if (n <= 0) this.refs.delete(reason);
      else this.refs.set(reason, n);
      this.maybeRefresh();
    };
  }

  /**
   * A newly-activated service worker wants to take over (App-1/App-2). Reload
   * immediately when nothing is dirty; otherwise remember the reload and apply
   * it automatically once the last dirty holder clears.
   */
  requestRefresh(refresh: () => void): void {
    this.refresh = refresh;
    this.pending = true;
    this.maybeRefresh();
  }

  private maybeRefresh(): void {
    if (!this.pending || this.dirty) return;
    const fn = this.refresh;
    this.pending = false;
    this.refresh = null;
    fn?.();
  }

  /** Test-only: clear all state between cases. */
  __resetForTests(): void {
    this.refs.clear();
    this.refresh = null;
    this.pending = false;
  }
}

export const refreshGuard = new RefreshGuard();
