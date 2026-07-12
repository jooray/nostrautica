<script lang="ts">
  // Attendee-facing event header: a wide banner with the event icon + title
  // overlaid. Both images are optional — generated gradients fill in so the
  // header always looks intentional.
  import type { EventContext } from "$lib/events/event-context.js";
  import { defaultEventBanner, defaultEventIcon } from "$lib/media/image.js";

  let { ctx, compact = false }: { ctx: EventContext; compact?: boolean } = $props();

  const banner = $derived(ctx.banner || defaultEventBanner(ctx.title));
  const icon = $derived(ctx.icon || defaultEventIcon(ctx.title, ctx.title));
</script>

<div class="event-header" class:compact>
  <img class="banner" src={banner} alt="" />
  <div class="overlay">
    <img class="icon" src={icon} alt="" />
    {#if !compact}<span class="title">{ctx.title}</span>{/if}
  </div>
</div>

<style>
  .event-header {
    position: relative;
    border-radius: var(--radius);
    overflow: hidden;
    margin: 0.5rem 0 1rem;
  }
  .banner {
    display: block;
    width: 100%;
    aspect-ratio: 5 / 2;
    object-fit: cover;
  }
  .compact .banner {
    aspect-ratio: 6 / 1;
  }
  .overlay {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: flex-end;
    gap: 0.75rem;
    padding: 1rem;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.7), transparent);
  }
  .icon {
    width: 56px;
    height: 56px;
    border-radius: 14px;
    border: 2px solid rgba(255, 255, 255, 0.85);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
    flex: none;
    background: var(--bg-elev);
  }
  .compact .icon {
    width: 40px;
    height: 40px;
    border-radius: 10px;
  }
  .title {
    color: #fff;
    font-weight: 700;
    font-size: 1.35rem;
    letter-spacing: -0.02em;
    text-shadow: 0 1px 8px rgba(0, 0, 0, 0.6);
    line-height: 1.15;
  }
</style>
