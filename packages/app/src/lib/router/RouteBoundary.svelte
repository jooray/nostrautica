<script lang="ts">
  /**
   * One screen's worth of blast radius. A throw during a component's CREATION is
   * otherwise both unrecoverable and invisible in this app: Svelte 5 builds the
   * incoming branch offscreen and commits it only on success, so the throw aborts
   * the swap, whatever was on screen before stays, and the user is left staring at
   * a pane that never finishes. That is how one duplicate `{#each}` key made the
   * Chat tab permanently unreachable in production (2026-07-24) — no error, no
   * retry, no way back in short of clearing site data.
   *
   * Used in two places, so eager AND lazy routes are both covered: around the
   * whole dispatch in routes/+page.svelte, and around the resolved component
   * inside LazyRoute. The inner one wins for lazy routes (a boundary catches at
   * the nearest enclosing scope), which is what we want — a code-split route
   * fails alone instead of blanking the shell.
   */
  import type { Snippet } from "svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { children }: { children: Snippet } = $props();
</script>

<svelte:boundary onerror={(e) => console.error("[route] render failed", e)}>
  {@render children()}
  {#snippet failed(_error, reset)}
    <div class="card warn" role="alert" style="margin-top:2rem">
      <p style="margin:0">{t("route.renderFailed")}</p>
      <div class="row" style="margin-top:0.6rem">
        <button class="btn inline" onclick={reset}>{t("error.state.retry")}</button>
      </div>
    </div>
  {/snippet}
</svelte:boundary>
