<script lang="ts">
  /**
   * The event you are in, at the top of the desktop rail, and a way to leave for
   * another one.
   *
   * Two things it deliberately does not do. It does not draw an initials tile
   * when the event has no icon: a circle containing two letters of a title that
   * is written out in full immediately to its right carries no information, and
   * the rail is the one place in the app where that identity is permanent enough
   * for the noise to matter. And it does not reserve the icon column unless at
   * least one event in the menu actually has an icon, so a list of iconless
   * events stays flush left instead of hanging off an invisible grid.
   *
   * The menu is `position: fixed`, which only works because the rail dropped its
   * `backdrop-filter` on desktop: filters, transforms and backdrop-filters all
   * create a containing block for fixed descendants, so a menu inside a blurred
   * rail would have been trapped in it and clipped by its scroll.
   */
  import { router } from "$lib/router/router.svelte.js";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { safeImageSrc, EXTERNAL_IMG_REFERRER_POLICY } from "$lib/stores/external-images.svelte.js";
  import type { EventContext } from "$lib/events/event-context.js";
  import Icon from "$lib/components/icons/Icon.svelte";
  import { focusTrap } from "./focus-trap.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { ctx, naddr }: { ctx: EventContext; naddr: string } = $props();

  let open = $state(false);

  const currentIcon = $derived(safeImageSrc(ctx.icon));
  /** Everything except the one you are already in. */
  const others = $derived(recentEvents.list.filter((e) => e.naddr !== naddr));
  /** Reserve the icon column only if it would hold something. */
  const anyIcons = $derived(others.some((e) => !!safeImageSrc(e.icon)));

  function goto(target: string) {
    open = false;
    router.go({ name: "event", naddr: target });
  }
  function allEvents() {
    open = false;
    router.go({ name: "home" });
  }
</script>

<button
  class="trigger"
  aria-haspopup="menu"
  aria-expanded={open}
  title={ctx.title}
  onclick={() => (open = !open)}
>
  {#if currentIcon}
    <img class="ic" src={currentIcon} alt="" referrerpolicy={EXTERNAL_IMG_REFERRER_POLICY} />
  {/if}
  <span class="name">{ctx.title}</span>
  <span class="chev" class:open><Icon name="chevronDown" size={14} /></span>
</button>

{#if open}
  <!-- Catches the click that dismisses the menu. Not focusable and hidden from
       assistive tech: Escape and the trigger are the keyboard paths. -->
  <button class="scrim" tabindex="-1" aria-hidden="true" onclick={() => (open = false)}></button>
  <div
    class="menu"
    role="menu"
    tabindex="-1"
    aria-label={t("nav.switchEvent")}
    use:focusTrap
    onkeydown={(e) => {
      if (e.key === "Escape") open = false;
    }}
  >
    {#each others as e (e.naddr)}
      {@const icon = safeImageSrc(e.icon)}
      <button class="row" role="menuitem" onclick={() => goto(e.naddr)}>
        {#if anyIcons}
          <span class="slot">
            {#if icon}<img class="ic" src={icon} alt="" referrerpolicy={EXTERNAL_IMG_REFERRER_POLICY} />{/if}
          </span>
        {/if}
        <span class="row-name">{e.title}</span>
      </button>
    {/each}
    {#if others.length > 0}<div class="rule"></div>{/if}
    <button class="row" role="menuitem" onclick={allEvents}>
      {#if anyIcons}<span class="slot"></span>{/if}
      <span class="row-name">{t("more.allEvents")}</span>
    </button>
  </div>
{/if}

<style>
  .trigger {
    display: none;
  }
  /* Only the desktop rail has room for this; on a phone the event's identity
     lives in the strip above the content. */
  @media (min-width: 1000px) {
    .trigger {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      min-width: 0;
      margin: 0 0 1rem;
      padding: 0.4rem 0.45rem;
      background: none;
      border: none;
      color: var(--text);
      font: inherit;
      text-align: left;
      cursor: pointer;
      border-radius: var(--radius-sm);
    }
    .trigger:hover {
      background: var(--bg-elev2);
    }
    .ic {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      object-fit: cover;
      flex: none;
    }
    .name {
      flex: 1;
      min-width: 0;
      font-family: var(--font-display);
      font-size: 1rem;
      font-weight: 600;
      line-height: 1.2;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chev {
      flex: none;
      display: inline-flex;
      color: var(--text-dim);
      transition: transform 0.15s ease;
    }
    .chev.open {
      transform: rotate(180deg);
    }
    .scrim {
      position: fixed;
      inset: 0;
      z-index: 29;
      background: none;
      border: none;
      cursor: default;
    }
    .menu {
      position: fixed;
      z-index: 30;
      top: 3.3rem;
      left: 0.6rem;
      min-width: calc(var(--rail) - 1.2rem);
      max-width: 22rem;
      max-height: min(60vh, 28rem);
      overflow-y: auto;
      padding: 0.3rem;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: var(--bg-raised);
      box-shadow: var(--shadow-raised);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      min-width: 0;
      padding: 0.45rem 0.5rem;
      background: none;
      border: none;
      color: var(--text);
      font: inherit;
      text-align: left;
      cursor: pointer;
      border-radius: var(--radius-sm);
    }
    .row:hover {
      background: var(--bg-elev2);
    }
    .slot {
      width: 22px;
      flex: none;
      display: inline-flex;
    }
    .row-name {
      flex: 1;
      min-width: 0;
      font-size: 0.92rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rule {
      height: 1px;
      margin: 0.3rem 0.2rem;
      background: var(--border);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .chev {
      transition: none;
    }
  }
</style>
