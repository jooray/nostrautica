<script lang="ts">
  // Confidence read for a match (redesign §8): a small route glyph + a
  // plain-language band label. The band is encoded in BOTH the label text and
  // the glyph SHAPE (rising curve / gentle arc / dashed line), never colour
  // alone (A6). Only "strong" uses the accent colour.
  import { confidenceBand } from "$lib/events/confidence.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { score, size = "md" }: { score: number; size?: "sm" | "md" } = $props();

  const band = $derived(confidenceBand(score));
  const labelKey = $derived(
    band === "strong"
      ? ("matches.band.strong" as const)
      : band === "good"
        ? ("matches.band.good" as const)
        : ("matches.band.hello" as const),
  );
  const w = $derived(size === "sm" ? 26 : 30);
  const h = $derived(size === "sm" ? 14 : 16);
</script>

<span class="conf band-{band}">
  <svg
    class="route"
    width={w}
    height={h}
    viewBox="0 0 30 16"
    fill="none"
    aria-hidden="true"
  >
    {#if band === "strong"}
      <path d="M3 12 Q11 2 27 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <circle cx="3" cy="12" r="2.4" fill="currentColor" />
      <circle cx="27" cy="4" r="2.8" fill="currentColor" />
    {:else if band === "good"}
      <path d="M3 11 Q13 6 27 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <circle cx="3" cy="11" r="2.4" fill="currentColor" />
      <circle cx="27" cy="7" r="2.6" fill="currentColor" />
    {:else}
      <path d="M3 9 L27 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="1 4" />
      <circle cx="3" cy="9" r="2.2" fill="currentColor" />
      <circle cx="27" cy="9" r="2.2" fill="currentColor" />
    {/if}
  </svg>
  <span class="lab">{t(labelKey)}</span>
</span>

<style>
  .conf {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .lab {
    font-weight: 650;
    font-size: 0.8rem;
  }
  .band-strong {
    color: var(--accent);
  }
  .band-good {
    color: var(--text);
  }
  .band-hello {
    color: var(--text-dim);
  }
</style>
