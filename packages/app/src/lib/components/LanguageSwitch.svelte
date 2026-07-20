<script lang="ts">
  // Compact manual language override for the pre-auth screens (Login, Join —
  // spec §7.1). These pages may have just auto-adopted the event's language
  // (event-context.ts loadEventContext, logged-out only); this is the escape
  // hatch back to a different one before Settings is ever discovered. Text
  // labels only, deliberately — no flag icons (a flag maps a language to a
  // country, which is wrong for languages spoken across borders and alienates
  // readers outside the "flagged" country).
  import { i18n, t } from "$lib/i18n/i18n.svelte.js";
  import { LOCALES, LOCALE_NAMES, type Locale } from "$lib/i18n/messages.js";
</script>

<select
  class="lang-switch"
  aria-label={t("settings.language")}
  value={i18n.locale}
  onchange={(e) => i18n.set((e.currentTarget as HTMLSelectElement).value as Locale)}
>
  {#each LOCALES as loc (loc)}
    <option value={loc}>{LOCALE_NAMES[loc]}</option>
  {/each}
</select>

<style>
  .lang-switch {
    font: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    padding: 0.3rem 1.6rem 0.3rem 0.7rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-elev);
    color: var(--text);
    cursor: pointer;
  }
</style>
