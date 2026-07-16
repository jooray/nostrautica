<script lang="ts">
  // Event header v2 (redesign §6.4/§7.1). A calm nautica identity for the event:
  // a low-contrast colour wash derived from the event pubkey (set globally by the
  // theme injector, so an organizer's 31609 CSS can override it), a deterministic
  // constellation "route" motif, a serif display title and a meta row with the
  // horizon-star (when) and waypoint (where) icons — never a calendar or clock.
  //
  // Full variant → the Overview hero. Compact variant → a single persistent row
  // on subpages that taps through to Overview. When the organizer uploaded a
  // banner it becomes the background under the wash and the constellation is
  // suppressed.
  import type { EventContext } from "$lib/events/event-context.js";
  import type { MessageKey } from "$lib/i18n/messages.js";
  import { defaultEventIcon } from "$lib/media/image.js";
  import { eventConstellation } from "$lib/events/constellation.js";
  import { parseCoordinate } from "@nostrautica/protocol";
  import { router } from "$lib/router/router.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import Icon from "$lib/components/icons/Icon.svelte";

  let {
    ctx,
    compact = false,
    link = false,
    status,
  }: {
    ctx: EventContext;
    compact?: boolean;
    link?: boolean;
    status?: { labelKey: MessageKey; tone: "ok" | "accent" | "warn" | "neutral" };
  } = $props();

  const eventPubkey = $derived.by(() => {
    try {
      return parseCoordinate(ctx.coordinate).pubkey;
    } catch {
      return ctx.coordinate;
    }
  });
  const constellation = $derived(eventConstellation(eventPubkey));
  const icon = $derived(ctx.icon || defaultEventIcon(ctx.title, ctx.title));
  const hasBanner = $derived(!!ctx.banner);

  function fmtDate(unixSec: number): string {
    return new Date(unixSec * 1000).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }

  function go() {
    if (link) router.go({ name: "event", naddr: ctx.naddr });
  }
</script>

<svelte:element
  this={link ? "button" : "div"}
  class="evt-head"
  class:compact
  class:has-banner={hasBanner}
  class:tappable={link}
  onclick={go}
  role={link ? "link" : undefined}
>
  {#if hasBanner}
    <img class="banner-bg" src={ctx.banner} alt="" />
  {/if}
  <div class="wash" aria-hidden="true"></div>
  {#if !hasBanner}
    <svg class="constellation" viewBox="0 0 300 120" fill="none" aria-hidden="true">
      <path d={constellation.path} stroke="var(--route-line)" stroke-width="1" />
      {#each constellation.points as p, i (i)}
        <circle cx={p.x} cy={p.y} r={p.r} fill="currentColor" />
      {/each}
    </svg>
  {/if}

  <div class="inner" class:on-banner={hasBanner}>
    {#if compact}
      <img class="icon" src={icon} alt="" />
      <span class="kname">{ctx.title}</span>
      {#if status}
        <span class="badge {status.tone === 'neutral' ? '' : status.tone}">{t(status.labelKey)}</span>
      {/if}
    {:else}
      <div class="kname">{ctx.title}</div>
      <div class="kmeta">
        {#if ctx.start}
          <span class="mi"><Icon name="horizon" size={15} /> {fmtDate(ctx.start)}</span>
        {/if}
        {#if ctx.location}
          {#if ctx.start}<span class="sep">·</span>{/if}
          <span class="mi"><Icon name="waypoint" size={15} /> {ctx.location}</span>
        {/if}
        {#if status}
          {#if ctx.start || ctx.location}<span class="sep">·</span>{/if}
          <span class="badge {status.tone === 'neutral' ? '' : status.tone}">{t(status.labelKey)}</span>
        {/if}
      </div>
    {/if}
  </div>
</svelte:element>

<style>
  .evt-head {
    position: relative;
    display: block;
    width: 100%;
    box-sizing: border-box;
    border-radius: var(--radius);
    overflow: hidden;
    margin: 0.5rem 0 1rem;
    padding: 0;
    border: 1px solid var(--card-border);
    background: var(--bg-elev);
    text-align: left;
    color: inherit;
    font: inherit;
  }
  .tappable {
    cursor: pointer;
  }
  .banner-bg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .wash {
    position: absolute;
    inset: 0;
    background: var(--event-wash);
  }
  .constellation {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    color: var(--accent);
    opacity: 0.5;
  }
  .inner {
    position: relative;
    padding: 1rem 1.05rem 0.9rem;
  }
  .compact .inner {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.6rem 0.85rem;
  }
  /* Give a real banner image room to be seen — anchor the title to the bottom over
     the scrim. Only when a banner is set; generated-gradient headers stay compact. */
  .evt-head.has-banner .inner {
    min-height: 120px;
  }
  /* A real banner renders at the same 5:2 the create-form crops and previews
     use (capped on desktop so it never dominates the viewport). Flex keeps the
     title anchored to the bottom over the scrim at any height. */
  .evt-head.has-banner:not(.compact) {
    aspect-ratio: 5 / 2;
    max-height: 260px;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
  }
  .evt-head.has-banner:not(.compact) .inner {
    /* height now comes from the root's 5:2 ratio; the inner hugs its content */
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
  }
  .compact.has-banner .inner {
    align-items: flex-end;
  }
  /* When a banner backs the header, drop a scrim so text stays legible. */
  .inner.on-banner {
    background: linear-gradient(to top, rgba(0, 0, 0, 0.72), rgba(0, 0, 0, 0.28));
  }
  .inner.on-banner .kname,
  .inner.on-banner .kmeta {
    color: #fff;
  }
  .icon {
    width: 24px;
    height: 24px;
    border-radius: 7px;
    flex: none;
    background: var(--bg-elev);
  }
  .kname {
    font-family: var(--font-display);
    font-weight: 600;
    letter-spacing: 0;
    line-height: 1.12;
    text-wrap: balance;
    margin: 0 0 0.25rem;
    font-size: 1.4rem;
  }
  .compact .kname {
    margin: 0;
    font-size: 1rem;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kmeta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem 0.45rem;
    font-size: 0.8rem;
    color: var(--text-dim);
  }
  .kmeta .mi {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .kmeta .sep {
    opacity: 0.5;
  }
  .compact .badge {
    flex: none;
  }
</style>
