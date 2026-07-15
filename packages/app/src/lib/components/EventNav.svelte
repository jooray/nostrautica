<script lang="ts">
  // Event-scoped bottom nav (redesign §6.2): Overview · People · Matches ·
  // Updates · More. People/Matches are gated by role + config so a tab never
  // dead-ends at "join first". Replicates BottomNav's shipped a11y pattern
  // verbatim: aria-current="page", aria-hidden icons, a non-colour ::before
  // marker (forced-colors safe), 48px targets, safe-area padding.
  import { router } from "$lib/router/router.svelte.js";
  import { session } from "$lib/signer/session.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import { eventShell } from "$lib/stores/event-shell.svelte.js";
  import Icon from "$lib/components/icons/Icon.svelte";
  import Avatar from "$lib/components/Avatar.svelte";

  let { naddr }: { naddr: string } = $props();

  const route = $derived(router.route);
  function active(...names: string[]): boolean {
    return names.includes(route.name);
  }
</script>

<nav class="event-nav" aria-label={t("nav.eventPrimary")}>
  <button
    aria-current={active("event", "join") ? "page" : undefined}
    class:active={active("event", "join")}
    onclick={() => router.go({ name: "event", naddr })}
  >
    <span class="ico"><Icon name="compass" size={24} /></span><span class="lbl">{t("nav.overview")}</span>
  </button>

  {#if eventShell.showPeople}
    <button
      aria-current={active("attendees", "attendee") ? "page" : undefined}
      class:active={active("attendees", "attendee")}
      onclick={() => router.go({ name: "attendees", naddr })}
    >
      <span class="ico"><Icon name="people" size={24} /></span><span class="lbl">{t("nav.people")}</span>
    </button>
  {/if}

  {#if eventShell.showMatches}
    <button
      aria-current={active("matches") ? "page" : undefined}
      class:active={active("matches")}
      onclick={() => router.go({ name: "matches", naddr })}
    >
      <span class="ico"><Icon name="constellation" size={24} /></span><span class="lbl">{t("nav.matches")}</span>
    </button>
  {/if}

  <button
    aria-current={active("posts", "post") ? "page" : undefined}
    class:active={active("posts", "post")}
    onclick={() => router.go({ name: "posts", naddr })}
  >
    <span class="ico"><Icon name="horn" size={24} /></span><span class="lbl">{t("nav.updates")}</span>
  </button>

  <button
    aria-current={active("eventMore") ? "page" : undefined}
    class:active={active("eventMore")}
    onclick={() => router.go({ name: "eventMore", naddr })}
  >
    <span class="ico">
      {#if session.loggedIn && session.pubkey}
        <Avatar pubkey={session.pubkey} size={22} />
      {:else}
        <Icon name="person" size={24} />
      {/if}
    </span><span class="lbl">{t("nav.more")}</span>
  </button>
</nav>

<style>
  .event-nav {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 20;
    display: flex;
    justify-content: space-around;
    gap: 0.25rem;
    padding: 0.4rem 0.5rem calc(0.5rem + env(safe-area-inset-bottom));
    background: color-mix(in srgb, var(--bg-raised) 92%, transparent);
    backdrop-filter: blur(10px);
    box-shadow: var(--shadow-raised);
    border-top: 1px solid var(--border);
  }
  button {
    position: relative;
    flex: 1;
    max-width: 6rem;
    min-height: var(--nav-target);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.2rem;
    background: none;
    border: none;
    color: var(--text-dim);
    font: inherit;
    cursor: pointer;
    padding: 0.25rem 0.15rem;
    border-radius: 10px;
  }
  button.active {
    color: var(--accent);
    font-weight: 700;
  }
  /* Non-color selected marker (A6), forced-colors safe. */
  button.active::before {
    content: "";
    position: absolute;
    top: 0;
    width: 1.4rem;
    height: 2px;
    border-radius: 2px;
    background: currentColor;
  }
  .ico {
    display: grid;
    place-items: center;
    line-height: 0;
    min-height: 24px;
  }
  .lbl {
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
  }
</style>
