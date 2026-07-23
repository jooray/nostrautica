<script lang="ts">
  // Operational overview dashboard (audit UX-A5). A compact, scannable header of
  // headline metrics with urgent exceptions floated above the healthy detail.
  // Owns only its render — all state is derived and passed in (buildOverview),
  // so it's a pure view over the admin domain's numbers.
  import type { OverviewMetric } from "$lib/events/admin-overview.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let {
    exceptions,
    metrics,
  }: { exceptions: OverviewMetric[]; metrics: OverviewMetric[] } = $props();

  // Non-count metric values are short status tokens the view localizes.
  function valueText(value: number | string): string {
    if (typeof value === "number") return String(value);
    switch (value) {
      case "yes":
        return t("admin.overview.yes");
      case "no":
        return t("admin.overview.no");
      case "coord.ok":
        return t("admin.overview.coord.ok");
      case "coord.stale":
        return t("admin.overview.coord.stale");
      case "coord.unknown":
        return t("admin.overview.coord.unknown");
      case "billing.blocked":
        return t("admin.overview.billing.blocked");
      default:
        return value;
    }
  }
</script>

{#if exceptions.length}
  <div class="excepts" role="status">
    {#each exceptions as m (m.id)}
      <div class="except">
        <span class="badge warn">{valueText(m.value)}</span>
        <span>{t(m.labelKey)}</span>
      </div>
    {/each}
  </div>
{/if}

<div class="grid">
  {#each metrics as m (m.id)}
    <div class="metric {m.tone}">
      <span class="v">{valueText(m.value)}</span>
      <span class="l">{t(m.labelKey)}</span>
    </div>
  {/each}
</div>

<style>
  .excepts {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0 0 0.6rem;
  }
  .except {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    border-left: 3px solid var(--danger);
    background: var(--bg-elev);
    border-radius: 6px;
    font-size: 0.85rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
    gap: 0.5rem;
    margin: 0 0 0.75rem;
  }
  .metric {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-elev);
  }
  .metric .v {
    font-size: 1.2rem;
    font-weight: 700;
  }
  .metric .l {
    font-size: 0.72rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .metric.warn .v {
    color: var(--danger);
  }
  .metric.ok .v {
    color: var(--ok);
  }
</style>
