<script lang="ts">
  /**
   * Event logistics block (audit §7.4.9). Sparse start-date-only header text is
   * replaced here with the full picture: localized start–end with time zone, a
   * happening-now / upcoming / ended state, a client-side add-to-calendar (.ics
   * Blob download — no server), and a directions link for the venue. Renders
   * nothing when the event carries no start time.
   */
  import type { EventContext } from "$lib/events/event-context.js";
  import { eventPhase, daysUntil, formatRange, directionsUrl } from "$lib/events/logistics.js";
  import { buildIcs, icsFilename } from "$lib/events/ics.js";
  import { i18n, t, tp } from "$lib/i18n/i18n.svelte.js";

  let { ctx }: { ctx: EventContext } = $props();

  // A live clock, refreshed each minute, so the happening-now state flips on its
  // own without a reload.
  let now = $state(Math.floor(Date.now() / 1000));
  $effect(() => {
    const id = setInterval(() => (now = Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(id);
  });

  const phase = $derived(eventPhase(ctx.start, ctx.end, now));
  const days = $derived(daysUntil(ctx.start, now));
  const range = $derived(formatRange(ctx.start, ctx.end, i18n.locale));
  const directions = $derived(directionsUrl(ctx.location));

  function addToCalendar() {
    if (!ctx.start) return;
    const url = typeof location !== "undefined" ? `${location.origin}${location.pathname}#/e/${ctx.naddr}` : undefined;
    const ics = buildIcs({
      uid: ctx.coordinate,
      title: ctx.title,
      description: ctx.summary,
      location: ctx.location,
      start: ctx.start,
      end: ctx.end,
      url,
    });
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = icsFilename(ctx.title);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 0);
  }
</script>

{#if ctx.start}
  <div class="logistics card">
    <div class="when">
      {#if phase === "happening"}
        <span class="badge ok" role="status">{t("logistics.happeningNow")}</span>
      {:else if phase === "upcoming" && days !== null}
        <span class="badge">{days === 0 ? t("logistics.today") : tp("logistics.inDays", days)}</span>
      {:else if phase === "ended"}
        <span class="badge muted">{t("logistics.ended")}</span>
      {/if}
      <span class="range">{range}</span>
    </div>
    {#if ctx.location}
      <div class="where">
        <span class="loc">{ctx.location}</span>
        {#if directions}
          <a class="btn inline" href={directions} target="_blank" rel="noopener noreferrer">
            {t("logistics.directions")}
          </a>
        {/if}
      </div>
    {/if}
    <div class="acts">
      <button type="button" class="btn inline" onclick={addToCalendar}>
        {t("logistics.addToCalendar")}
      </button>
    </div>
  </div>
{/if}

<style>
  .logistics {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .when {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .range {
    font-weight: 600;
  }
  .where {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    color: var(--text-dim);
  }
  .acts {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .badge.muted {
    color: var(--text-dim);
  }
</style>
