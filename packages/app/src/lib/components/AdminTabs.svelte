<script lang="ts">
  // Sub-nav between the two organizer surfaces (UX split): day-to-day
  // Administration (join requests, attendees, invites, moderation, posts) vs
  // one-time Event settings (metadata, menu/layout, appearance, coordinator,
  // talks/chat mode, co-organizers). Same route names the rest of the app uses;
  // aria-current mirrors the pattern in EventNav/BottomNav.
  import { router } from "$lib/router/router.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { naddr }: { naddr: string } = $props();

  const route = $derived(router.route);
</script>

<nav class="admin-tabs" aria-label={t("admin.settings.title")}>
  <button
    aria-current={route.name === "admin" ? "page" : undefined}
    class:active={route.name === "admin"}
    onclick={() => router.go({ name: "admin", naddr })}
  >
    {t("admin.tab.manage")}
  </button>
  <button
    aria-current={route.name === "eventSettings" ? "page" : undefined}
    class:active={route.name === "eventSettings"}
    onclick={() => router.go({ name: "eventSettings", naddr })}
  >
    {t("admin.tab.settings")}
  </button>
</nav>

<style>
  .admin-tabs {
    display: flex;
    gap: 0.25rem;
    margin: 0.5rem 0 1rem;
    padding: 0.25rem;
    background: var(--bg-elev2, transparent);
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  .admin-tabs button {
    flex: 1;
    min-height: 40px;
    background: none;
    border: none;
    border-radius: 9px;
    color: var(--text-dim);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    padding: 0.4rem 0.6rem;
  }
  .admin-tabs button.active {
    background: var(--bg-raised);
    color: var(--accent);
    box-shadow: var(--shadow-raised);
  }
</style>
