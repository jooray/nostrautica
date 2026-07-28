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
        if (!recoverFromStaleChunk(err)) failed = true;
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
{:else}
  <p class="muted" role="status" style="margin-top:2rem">{t("app.loading")}</p>
{/if}
