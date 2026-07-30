<script lang="ts">
  // The body of a match (kind 31605 entry): confidence read, the host-voice
  // reasoning, the conversation starters, and the collapsed score breakdown.
  //
  // Extracted from Matches.svelte (2026-07-29) so the SAME match can be shown on
  // the attendee-detail page: the Matches tab could open a person's profile but
  // the profile had no way back to "why we matched", which is the one thing the
  // viewer actually wants when they get there (UX feedback 2026-07-29).
  //
  // Deliberately renders no avatar/name head — the two call sites frame it
  // differently (a list card vs. a section of a profile already showing who this
  // is), so framing stays with the caller. Actions come in as a snippet rendered
  // just above the score breakdown (which stays last, its border-top acting as
  // the card's footer rule); passing the whole wrapper element keeps the
  // caller's own scoped button styles applying to it. Multiple root elements, so
  // the caller's flex/gap governs the spacing.
  import type { Snippet } from "svelte";
  import type { Match } from "@nostrautica/protocol";
  import ConfidenceBadge from "./ConfidenceBadge.svelte";
  import Icon from "./icons/Icon.svelte";
  import { t, i18n } from "$lib/i18n/i18n.svelte.js";

  let { match, actions }: { match: Match; actions?: Snippet } = $props();

  /**
   * Scores are 0–1 on the wire and stay that way everywhere else — this is a
   * display concern only. "85 %" reads as a score; "0.85" reads as a debug dump.
   * Intl gets the per-locale typography right on its own (sk/cs want the space
   * before the sign, en does not). Clamped because the 31605 schema types these
   * as a plain z.number() with no range bound (schemas.ts), so a future or
   * misbehaving coordinator must not be able to render "8500 %".
   */
  function pct(v: number): string {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
    return new Intl.NumberFormat(i18n.locale, {
      style: "percent",
      maximumFractionDigits: 0,
    }).format(clamped);
  }
</script>

<ConfidenceBadge score={match.score} />

<!-- Reasoning is the product — full body size, no longer under a %. -->
<p class="reason">{match.reasoning}</p>

<!-- Icebreakers (§7.3 kind 31605): concrete conversation starters, if any. -->
{#if match.icebreakers && match.icebreakers.length > 0}
  <div class="icebreakers">
    <div class="ib-label">{t("matches.icebreakers")}</div>
    <ul class="ib-list">
      {#each [...new Set(match.icebreakers)] as ib (ib)}
        <li>{ib}</li>
      {/each}
    </ul>
  </div>
{/if}

{#if actions}{@render actions()}{/if}

<details class="score">
  <summary>
    {t("matches.scoreDetails")}
    <span class="chev"><Icon name="chevronDown" size={16} /></span>
  </summary>
  <div class="dims">
    <div class="d"><span>{t("matches.dim.similarity")}</span><b>{pct(match.similarity)}</b></div>
    <div class="d"><span>{t("matches.dim.complementarity")}</span><b>{pct(match.complementarity)}</b></div>
    <div class="d"><span>{t("matches.dim.overall")}</span><b>{pct(match.score)}</b></div>
  </div>
</details>

<style>
  .reason {
    margin: 0;
    font-size: 0.95rem;
    line-height: 1.5;
  }
  .icebreakers {
    margin: 0;
  }
  .ib-label {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 0.7rem;
    font-weight: 650;
    color: var(--text-dim);
    margin-bottom: 0.2rem;
  }
  .ib-list {
    margin: 0;
    padding-left: 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.9rem;
    line-height: 1.45;
  }
  details.score {
    border-top: 1px solid var(--border);
    padding-top: 0.55rem;
  }
  details.score summary {
    list-style: none;
    cursor: pointer;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  details.score summary::-webkit-details-marker {
    display: none;
  }
  details.score .chev {
    display: inline-flex;
    transition: transform 0.15s ease;
  }
  details.score[open] .chev {
    transform: rotate(180deg);
  }
  .dims {
    display: flex;
    gap: 1.1rem;
    margin-top: 0.5rem;
    font-size: 0.82rem;
  }
  .dims .d {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .dims .d span {
    color: var(--text-dim);
    font-size: 0.72rem;
  }
  .dims .d b {
    font-variant-numeric: tabular-nums;
    font-weight: 650;
  }
  @media (prefers-reduced-motion: reduce) {
    details.score .chev {
      transition: none;
    }
  }
</style>
