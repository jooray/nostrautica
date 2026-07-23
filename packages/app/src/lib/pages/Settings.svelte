<script lang="ts">
  import { theme, type ThemePref } from "$lib/stores/theme.svelte.js";
  import { i18n, t } from "$lib/i18n/i18n.svelte.js";
  import { LOCALES, LOCALE_NAMES, type MessageKey } from "$lib/i18n/messages.js";
  import { RELEASE_MANIFEST as rel } from "$lib/release.js";

  const about: { label: string; value: string }[] = [
    { label: "Release", value: rel.releaseId },
    { label: "App", value: rel.appVersion },
    { label: "Protocol", value: `${rel.protocolVersion} (wire v${rel.wireProtocolVersion})` },
    { label: "Commit", value: rel.gitSha.slice(0, 12) },
    { label: "Built", value: rel.buildTimestamp },
  ];

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

<div class="card">
  <div class="field-label">{t("settings.about")}</div>
  <dl class="about">
    {#each about as row (row.label)}
      <dt>{row.label}</dt>
      <dd>{row.value}</dd>
    {/each}
  </dl>
  <p class="muted" style="margin:0.5rem 0 0">{t("settings.about.hint")}</p>
</div>

<style>
  .about {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.15rem 0.75rem;
    margin: 0;
    font-size: 0.85rem;
  }
  .about dt {
    color: var(--muted, #888);
  }
  .about dd {
    margin: 0;
    font-family: var(--mono, ui-monospace, monospace);
    word-break: break-all;
  }
</style>
