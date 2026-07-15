<script lang="ts">
  import { theme, type ThemePref } from "$lib/stores/theme.svelte.js";
  import { i18n, t } from "$lib/i18n/i18n.svelte.js";
  import { LOCALES, LOCALE_NAMES, type MessageKey } from "$lib/i18n/messages.js";

  const themeOptions: { value: ThemePref; label: MessageKey }[] = [
    { value: "system", label: "settings.theme.system" },
    { value: "light", label: "settings.theme.light" },
    { value: "dark", label: "settings.theme.dark" },
  ];
</script>

<h1>{t("settings.title")}</h1>

<div class="card">
  <div class="field-label">{t("settings.theme")}</div>
  <div class="row" role="group" aria-label={t("settings.theme")}>
    {#each themeOptions as o (o.value)}
      <button class="btn inline" aria-pressed={theme.pref === o.value} class:primary={theme.pref === o.value} onclick={() => theme.set(o.value)}>
        {t(o.label)}
      </button>
    {/each}
  </div>
</div>

<div class="card">
  <div class="field-label">{t("settings.language")}</div>
  <div class="row" role="group" aria-label={t("settings.language")}>
    {#each LOCALES as loc (loc)}
      <button class="btn inline" aria-pressed={i18n.locale === loc} class:primary={i18n.locale === loc} onclick={() => i18n.set(loc)}>
        {LOCALE_NAMES[loc]}
      </button>
    {/each}
  </div>
</div>
