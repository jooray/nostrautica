<script lang="ts">
  import { theme, type ThemePref } from "$lib/stores/theme.svelte.js";
  import { i18n, t } from "$lib/i18n/i18n.svelte.js";
  import { LOCALES, LOCALE_NAMES, type MessageKey } from "$lib/i18n/messages.js";
  import { RELEASE_MANIFEST as rel } from "$lib/release.js";
  import { externalImages, setExternalImagesAllowed } from "$lib/stores/external-images.svelte.js";

  // These five labels were the last hardcoded English in the app — a Slovak or
  // Czech user's Settings page had an all-English block in the middle of it.
  // They survived because they sat in an array literal rather than in markup,
  // where a `t(...)` call would have been obvious.
  const about: { label: MessageKey; value: string }[] = [
    { label: "settings.about.release", value: rel.releaseId },
    { label: "settings.about.app", value: rel.appVersion },
    {
      label: "settings.about.protocol",
      value: `${rel.protocolVersion} (wire v${rel.wireProtocolVersion})`,
    },
    { label: "settings.about.commit", value: rel.gitSha.slice(0, 12) },
    { label: "settings.about.built", value: rel.buildTimestamp },
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
  <div class="field-label">{t("settings.privacy")}</div>
  <label class="row" style="gap:0.6rem;align-items:flex-start;cursor:pointer">
    <input
      type="checkbox"
      checked={externalImages.allowed}
      onchange={(e) => setExternalImagesAllowed(e.currentTarget.checked)}
    />
    <span>
      <span>{t("settings.externalImages")}</span>
      <span class="muted" style="display:block">{t("settings.externalImages.hint")}</span>
    </span>
  </label>
</div>

<div class="card">
  <div class="field-label">{t("settings.about")}</div>
  <dl class="about">
    {#each about as row (row.label)}
      <dt>{t(row.label)}</dt>
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
    /* `--muted` is not a token this app defines (the class is .muted; the token
       is --text-dim), so this always fell through to the #888 literal — about
       3.4:1 on the light ground, under the 4.5:1 floor stated at the top of
       app.css. --text-dim is the real token and meets it in both themes. */
    color: var(--text-dim);
  }
  .about dd {
    /* Likewise `--mono` doesn't exist; use the same stack as app.css's .mono so
       the build metadata is monospaced consistently with every other id/hash. */
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    margin: 0;
    word-break: break-all;
  }
</style>
