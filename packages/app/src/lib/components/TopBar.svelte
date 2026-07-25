<script lang="ts">
  import { theme } from "$lib/stores/theme.svelte.js";
  import { router, upLabelKey } from "$lib/router/router.svelte.js";
  import { eventNaddr } from "$lib/router/routes.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import Icon from "$lib/components/icons/Icon.svelte";
  import OutboxIndicator from "$lib/components/OutboxIndicator.svelte";

  function toggleTheme() {
    theme.set(theme.effective === "dark" ? "light" : "dark");
  }

  const showBack = $derived(router.route.name !== "home");
  // Contextual label naming where the button goes (e.g. "All events" on the
  // event home). The top-bar button is a hierarchical "up", not browser back.
  const backLabel = $derived(t(upLabelKey(router.route, router.eventOrigin)));
  // On event routes the event header carries context, so drop the brand link.
  const onEvent = $derived(eventNaddr(router.route) !== undefined);
</script>

<header class="topbar">
  <div class="row" style="gap:0.5rem">
    {#if showBack}
      <button class="btn inline back" style="width:auto" onclick={() => router.up()} aria-label={backLabel}>
        <Icon name="chevronLeft" size={18} /><span class="lbl">{backLabel}</span>
      </button>
    {/if}
    {#if !onEvent}
      <a class="brand" href="#/" aria-label={t("nav.homeAria")}>{t("app.brand")}</a>
    {/if}
    <OutboxIndicator />
  </div>
  <button
    class="btn inline theme-toggle"
    style="width:auto"
    onclick={toggleTheme}
    aria-label={t("nav.toggleTheme")}
    title={t("nav.toggleTheme")}
  >
    <Icon name={theme.effective === "dark" ? "sun" : "moon"} size={18} />
  </button>
</header>

<style>
  .back {
    gap: 0.3rem;
  }
  .back .lbl {
    line-height: 1;
    max-width: 45vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .theme-toggle {
    padding-left: 0.6rem;
    padding-right: 0.6rem;
  }
</style>
