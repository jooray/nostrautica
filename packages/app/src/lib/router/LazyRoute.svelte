<script lang="ts" module>
  /**
   * How a failed route import should be presented. Extracted so it can be
   * unit-tested — the state that matters here is the one that used to be
   * invisible, and it only appears with a specific combination of a stale-chunk
   * error and a held refresh guard.
   */
  export type LoadFailureState =
    /** Not a stale chunk (or recovery is spent): show the error card + Retry. */
    | "failed"
    /** Recovery reload fired: this view is about to be replaced. */
    | "recovering"
    /**
     * Recovery was requested but the reload is HELD behind unsaved work
     * (R8/refreshGuard). Nothing further happens on this screen until the holder
     * clears, so it must say so rather than render "Loading…" forever.
     */
    | "deferred";

  /**
   * Classify an import failure. `recover` is `recoverFromStaleChunk` (true = a
   * guarded reload was REQUESTED, which is not the same as performed) and
   * `refreshHeld` reads `refreshGuard.updateWaiting` (true = the reload is
   * waiting on unsaved work). Both are injected so the decision is testable
   * without a service worker or a DOM.
   */
  export function classifyLoadFailure(
    err: unknown,
    deps: { recover: (e: unknown) => boolean; refreshHeld: () => boolean },
  ): LoadFailureState {
    if (!deps.recover(err)) return "failed";
    return deps.refreshHeld() ? "deferred" : "recovering";
  }
</script>

<script lang="ts">
  /**
   * Renders a route component loaded on demand (audit §7.4.1). The catch-all page
   * eagerly imported every route — participant, organizer, chat, recording,
   * settings — into one ~1.2 MB entry chunk. This wrapper takes a STABLE module-
   * level `loader` (`() => import("...")`) so heavy/rare routes (Admin, Settings,
   * editors, chat, talks, recording) split into their own chunks fetched only
   * when navigated to. The loader identity is stable, so the load fires once;
   * `props` stay reactive and flow into the resolved component.
   */
  import type { Component } from "svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import { recoverFromStaleChunk } from "$lib/stale-chunk.js";
  import { refreshGuard } from "$lib/stores/refresh-guard.svelte.js";
  import RouteBoundary from "./RouteBoundary.svelte";

  // A single wrapper renders route components with differing prop shapes, which
  // one static type can't express — props flow through untyped by design (each
  // call site passes the props that route needs).
  let {
    loader,
    props = {},
  }: {
    loader: () => Promise<{ default: Component<any> }>;
    props?: Record<string, unknown>;
  } = $props();

  let Resolved = $state<Component<any> | null>(null);
  let failed = $state(false);
  /**
   * The import failed with a stale chunk AND the recovery reload was DEFERRED
   * behind unsaved work (R8's refreshGuard hold: a completed recording, a
   * selected file, an open draft).
   *
   * This is a real dead zone, not a theoretical one. After a new service worker
   * activates, a route this tab has never visited 404s — its chunk is gone from
   * the server and was never in the runtime cache. `recoverFromStaleChunk`
   * returns true (recovery WAS requested), so `failed` stays false, so this
   * component fell through to the bare "Loading…" line — and the reload it is
   * waiting on will not happen until the dirty holder clears, which may be
   * never, because the thing holding it is on a different screen. The user sees
   * a permanently loading page with no explanation and no control.
   *
   * `update.deferred` already says the right thing for this state ("an update is
   * ready and will apply automatically as soon as you finish what you're
   * typing") and is the same sentence the shell banner shows, so the two agree.
   */
  let recoveryDeferred = $state(false);
  // Bumped by the Retry button to re-run the import effect (the loader identity is
  // stable, so nothing else would re-trigger it after a failure).
  let attempt = $state(0);
  // The failure that produced the error card, so Retry can tell a stale-chunk
  // dead end (where re-importing a 404 can only fail again) from a transient one.
  let lastError = $state<unknown>(undefined);

  /**
   * Retry (R9). When the failure was a missing post-deploy chunk, re-running the
   * import is guaranteed to fail — the URL is a hard 404 — which is exactly why
   * this button looked dead in the field. Force recovery instead: it escalates to
   * purging the service worker that keeps re-serving the stale shell. Anything
   * else (a genuinely transient network blip) just re-imports.
   */
  function retry(): void {
    if (recoverFromStaleChunk(lastError, { force: true })) return;
    attempt++;
  }

  // Depends on `loader` (stable) and `attempt` — not on `props` — so a prop change
  // never re-triggers the import, but a manual retry does.
  $effect(() => {
    void attempt;
    const l = loader;
    let alive = true;
    Resolved = null;
    failed = false;
    recoveryDeferred = false;
    l()
      .then((m) => {
        if (alive) Resolved = m.default;
      })
      .catch((err) => {
        // Post-deploy stale shell: missing content-hashed chunk → auto-reload
        // once (PWA §10.2). Only surface the dead-end message if recovery did
        // not fire (offline, or we already reloaded once this tab).
        if (!alive) return;
        lastError = err;
        // Recovery being REQUESTED is not recovery having happened: when the
        // refresh guard holds unsaved work the reload waits, possibly forever,
        // and this view has to say so instead of rendering "Loading…".
        const state = classifyLoadFailure(err, {
          recover: (e) => recoverFromStaleChunk(e),
          refreshHeld: () => refreshGuard.updateWaiting,
        });
        failed = state === "failed";
        recoveryDeferred = state === "deferred";
      });
    return () => {
      alive = false;
    };
  });
</script>

{#if Resolved}
  {@const Comp = Resolved}
  <!-- Inner boundary (see RouteBoundary): a code-split route that throws during
       creation fails alone, instead of aborting the swap and leaving the
       "Loading…" placeholder below mounted forever. -->
  <RouteBoundary><Comp {...props} /></RouteBoundary>
{:else if failed}
  <div class="card warn" role="alert" style="margin-top:2rem">
    <p style="margin:0">{t("route.loadFailed")}</p>
    <div class="row" style="margin-top:0.6rem">
      <button class="btn inline" onclick={retry}>{t("error.state.retry")}</button>
    </div>
  </div>
{:else if recoveryDeferred}
  <!-- The chunk is gone (new deploy) and the recovery reload is waiting on
       unsaved work elsewhere in the app. Never a bare "Loading…" — that state
       does not resolve on its own. Deliberately NO Retry button: the reload is
       already queued, so re-importing a URL that is a hard 404 could only fail
       again (R9's "the Retry button looked dead in the field"), and forcing past
       the guard would destroy the very unsaved work it is holding for. The
       sentence is the same one the shell banner shows, and finishing that work
       IS the action. -->
  <div class="card" role="status" aria-live="polite" style="margin-top:2rem">
    <p style="margin:0">{t("update.deferred")}</p>
  </div>
{:else}
  <p class="muted" role="status" style="margin-top:2rem">{t("app.loading")}</p>
{/if}
