<script lang="ts">
  import { theme, type ThemePref } from "$lib/stores/theme.svelte.js";
  import { i18n, t } from "$lib/i18n/i18n.svelte.js";
  import { LOCALES, LOCALE_NAMES } from "$lib/i18n/messages.js";

  const themeOptions: { value: ThemePref; label: string }[] = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];
</script>

<h1>{t("settings.title")}</h1>

<div class="card">
  <div class="field-label">{t("settings.theme")}</div>
  <div class="row">
    {#each themeOptions as o (o.value)}
      <button class="btn inline" class:primary={theme.pref === o.value} onclick={() => theme.set(o.value)}>
        {o.label}
      </button>
    {/each}
  </div>
</div>

<div class="card">
  <div class="field-label">{t("settings.language")}</div>
  <div class="row">
    {#each LOCALES as loc (loc)}
      <button class="btn inline" class:primary={i18n.locale === loc} onclick={() => i18n.set(loc)}>
        {LOCALE_NAMES[loc]}
      </button>
    {/each}
  </div>
</div>
