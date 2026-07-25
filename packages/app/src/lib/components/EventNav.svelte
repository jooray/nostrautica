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
  import { whatsNew } from "$lib/stores/whats-new.svelte.js";
  import Icon from "$lib/components/icons/Icon.svelte";
  import Avatar from "$lib/components/Avatar.svelte";

  let { naddr }: { naddr: string } = $props();

  const route = $derived(router.route);
  // New-matches-since-last-visit badge (spec §13). Pure read of cache +
  // watermark — matchBadge never writes $state, so this derived cannot throw
  // state_unsafe_mutation / effect_update_depth_exceeded (the previous
  // refreshMatches write path did both, depending on where it ran).
  const newMatches = $derived(whatsNew.matchBadge(eventShell.ctx?.coordinate));
  function active(...names: string[]): boolean {
    return names.includes(route.name);
  }
  // The bar holds Overview · People · Matches · Chat · Updates · More. When both
  // Matches AND Chat are visible the bar is full, so Updates collapses into the
  // More menu (MARMOT-GROUP-CHAT §7) to keep tap targets comfortable.
  const collapseUpdates = $derived(eventShell.showMatches && eventShell.showChat);
</script>

{#snippet talksTab()}
  <button
    aria-current={active("talks", "talk") ? "page" : undefined}
    class:active={active("talks", "talk")}
    onclick={() => router.go({ name: "talks", naddr })}
  >
    <span class="ico"><Icon name="talks" size={24} /></span><span class="lbl">{t("nav.talks")}</span>
  </button>
{/snippet}

<nav class="event-nav" aria-label={t("nav.eventPrimary")}>
  <button
    aria-current={active("event", "join") ? "page" : undefined}
    class:active={active("event", "join")}
    onclick={() => router.go({ name: "event", naddr })}
  >
    <span class="ico"><Icon name="compass" size={24} /></span><span class="lbl">{t("nav.overview")}</span>
  </button>

  <!-- In "prerecord-first" mode Talks is featured before People (watch ahead). -->
  {#if eventShell.showTalks && eventShell.talksFirst}{@render talksTab()}{/if}

  {#if eventShell.showPeople}
    <button
      aria-current={active("attendees", "attendee") ? "page" : undefined}
      class:active={active("attendees", "attendee")}
      onclick={() => router.go({ name: "attendees", naddr })}
    >
      <span class="ico"><Icon name="people" size={24} /></span><span class="lbl">{t("nav.people")}</span>
    </button>
  {/if}

  {#if eventShell.showTalks && !eventShell.talksFirst}{@render talksTab()}{/if}

  {#if eventShell.showMatches}
    <button
      aria-current={active("matches") ? "page" : undefined}
      class:active={active("matches")}
      onclick={() => router.go({ name: "matches", naddr })}
    >
      <span class="ico">
        <Icon name="constellation" size={24} />
        {#if newMatches > 0 && !active("matches")}
          <span class="badge-count" aria-hidden="true">{newMatches > 9 ? "9+" : newMatches}</span>
        {/if}
      </span><span class="lbl"
        >{t("nav.matches")}{#if newMatches > 0 && !active("matches")}<span class="visually-hidden"
            >{t("nav.matches.new", { n: newMatches })}</span
          >{/if}</span
      >
    </button>
  {/if}

  {#if eventShell.showChat}
    <!-- Active on the event group chat AND the global chat list / DM threads
         reached from inside this event (Bug 1): the Chat tab stays lit so the
         user still reads as "in this event" while messaging. -->
    <button
      aria-current={active("chat", "dm", "dmPeer") ? "page" : undefined}
      class:active={active("chat", "dm", "dmPeer")}
      onclick={() => router.go({ name: "chat", naddr })}
    >
      <span class="ico"><Icon name="chat" size={24} /></span><span class="lbl">{t("nav.chat")}</span>
    </button>
  {/if}

  {#if !collapseUpdates}
    <button
      aria-current={active("posts", "post") ? "page" : undefined}
      class:active={active("posts", "post")}
      onclick={() => router.go({ name: "posts", naddr })}
    >
      <span class="ico"><Icon name="horn" size={24} /></span><span class="lbl">{t("nav.updates")}</span>
    </button>
  {/if}

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
    flex: 1 1 0;
    /* min-width:0 lets flex items shrink below content size so a full 6-item bar
       stays on one row at 320px / 200% zoom / long translated labels (§7.4.8). */
    min-width: 0;
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
    position: relative;
  }
  .badge-count {
    position: absolute;
    top: -6px;
    left: 50%;
    transform: translateX(30%);
    min-width: 1rem;
    padding: 0 0.2rem;
    height: 1rem;
    border-radius: 999px;
    background: var(--accent);
    color: var(--bg, #fff);
    font-size: 0.62rem;
    font-weight: 800;
    line-height: 1rem;
    text-align: center;
  }
  .lbl {
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Very narrow / high-zoom: shrink labels a touch so a long translated label
     ("Nastavenia", "Aktualizace") never forces horizontal overflow. */
  @media (max-width: 360px) {
    .lbl {
      font-size: 0.68rem;
    }
    button {
      padding: 0.25rem 0.1rem;
    }
  }
</style>
