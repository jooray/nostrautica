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

  // Depends only on `loader` (stable) — not on `props` — so a prop change never
  // re-triggers the import.
  $effect(() => {
    const l = loader;
    let alive = true;
    Resolved = null;
    failed = false;
    l()
      .then((m) => {
        if (alive) Resolved = m.default;
      })
      .catch(() => {
        if (alive) failed = true;
      });
    return () => {
      alive = false;
    };
  });
</script>

{#if Resolved}
  {@const Comp = Resolved}
  <Comp {...props} />
{:else if failed}
  <p class="muted" role="alert" style="margin-top:2rem">{t("route.loadFailed")}</p>
{:else}
  <p class="muted" role="status" style="margin-top:2rem">{t("app.loading")}</p>
{/if}
