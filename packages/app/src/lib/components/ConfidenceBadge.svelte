<script lang="ts">
  // Confidence read for a match (redesign §8, reworked 2026-07-20 — the plain-
  // text version tested unnoticeable at a glance). A pill so the eye catches
  // it before the reasoning paragraph, with three DISTINCT visual weights
  // (solid / tinted / neutral) so "strong" doesn't have to carry the whole
  // hierarchy alone. The band is still encoded in BOTH the label text and the
  // glyph SHAPE (rising curve / gentle arc / dashed line), never colour
  // alone (A6).
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
  const w = $derived(size === "sm" ? 28 : 32);
  const h = $derived(size === "sm" ? 14 : 16);
</script>

<span class="conf band-{band} size-{size}">
  <svg
    class="route"
    width={w}
    height={h}
    viewBox="0 0 30 16"
    fill="none"
    aria-hidden="true"
  >
    {#if band === "strong"}
      <path d="M3 12 Q11 2 27 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      <circle cx="3" cy="12" r="2.4" fill="currentColor" />
      <circle cx="27" cy="4" r="2.8" fill="currentColor" />
    {:else if band === "good"}
      <path d="M3 11 Q13 6 27 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      <circle cx="3" cy="11" r="2.4" fill="currentColor" />
      <circle cx="27" cy="7" r="2.6" fill="currentColor" />
    {:else}
      <path d="M3 9 L27 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-dasharray="1 4" />
      <circle cx="3" cy="9" r="2.2" fill="currentColor" />
      <circle cx="27" cy="9" r="2.2" fill="currentColor" />
    {/if}
  </svg>
  <span class="lab">{t(labelKey)}</span>
</span>

<style>
  .conf {
    display: inline-flex;
    align-self: flex-start;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.65rem 0.3rem 0.55rem;
    border-radius: 999px;
    border: 1px solid transparent;
  }
  .lab {
    font-weight: 700;
    font-size: 0.85rem;
    letter-spacing: 0.01em;
  }
  .size-sm {
    padding: 0.2rem 0.55rem 0.2rem 0.45rem;
  }
  .size-sm .lab {
    font-size: 0.78rem;
  }
  /* Strong: solid fill — the same visual weight as a primary CTA, so the best
     matches are unmissable even skimming a long list. */
  .band-strong {
    background: var(--accent-bg);
    color: var(--accent-contrast);
  }
  /* Good: tinted, reusing the app-wide "positive status" pair (.badge.ok)
     so it reads as a real signal, not a footnote next to the reasoning. */
  .band-good {
    background: var(--ok-soft);
    color: var(--ok);
  }
  /* Hello: neutral chip — genuinely the lowest tier, but still a labelled
     pill rather than bare text so it doesn't get lost against the card. */
  .band-hello {
    background: var(--bg-elev2);
    color: var(--text-dim);
    border-color: var(--border);
  }
</style>
