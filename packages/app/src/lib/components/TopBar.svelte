<script lang="ts">
  import { theme } from "$lib/stores/theme.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  function toggleTheme() {
    theme.set(theme.effective === "dark" ? "light" : "dark");
  }

  const showBack = $derived(router.route.name !== "home");
</script>

<header class="topbar">
  <div class="row" style="gap:0.5rem">
    {#if showBack}
      <button class="btn inline" style="width:auto" onclick={() => router.back()} aria-label={t("nav.backAria")}>
        {t("nav.back")}
      </button>
    {/if}
    <a class="brand" href="#/" aria-label={t("nav.homeAria")}>{t("app.brand")}</a>
  </div>
  <button
    class="btn inline"
    style="width:auto"
    onclick={toggleTheme}
    aria-label={t("nav.toggleTheme")}
    title={t("nav.toggleTheme")}
  >
    {theme.effective === "dark" ? "☀" : "☾"}
  </button>
</header>
