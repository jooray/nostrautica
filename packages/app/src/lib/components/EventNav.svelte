<script lang="ts">
  // Event-scoped bottom nav (redesign §6.2): Overview · People · Updates · More.
  // People is gated by role + config so a tab never dead-ends at "join first".
  // Matches merged INTO People (2026-09-13) — one list, matched people first —
  // so the new-matches badge now rides the People tab. Replicates BottomNav's shipped a11y pattern
  // verbatim: aria-current="page", aria-hidden icons, a non-colour ::before
  // marker (forced-colors safe), 48px targets, safe-area padding.
  import { router } from "$lib/router/router.svelte.js";
  import { session } from "$lib/signer/session.svelte.js";
  import { t, tp } from "$lib/i18n/i18n.svelte.js";
  import { eventShell } from "$lib/stores/event-shell.svelte.js";
  import { whatsNew } from "$lib/stores/whats-new.svelte.js";
  import Icon from "$lib/components/icons/Icon.svelte";
  import Avatar from "$lib/components/Avatar.svelte";
  import EventSwitcher from "$lib/components/EventSwitcher.svelte";
  import { dmUnread } from "$lib/stores/dm-unread.svelte.js";

  let { naddr }: { naddr: string } = $props();

  const route = $derived(router.route);
  // New-since-last-visit badge (spec §13): new matches AND new people on the
  // roster, as one number. Pure read of cache + watermark — peopleBadge never
  // writes $state, so this derived cannot throw state_unsafe_mutation /
  // effect_update_depth_exceeded (the previous refreshMatches write path did
  // both, depending on where it ran). The People list marks the same set on the
  // rows themselves, so the badge says how many and the list says which.
  const newPeople = $derived(whatsNew.peopleBadge(eventShell.ctx?.coordinate));
  function active(...names: string[]): boolean {
    return names.includes(route.name);
  }
  // The bar holds Overview · People · Chat · Updates · More — five at most, one
  // fewer than before the People/Matches merge. That is what let Updates come
  // back out of the More menu: it used to collapse there whenever Matches AND
  // Chat were both visible (MARMOT-GROUP-CHAT §7) because six tabs squeezed the
  // labels to the point of truncating ("Overvi…"). Five fit.
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
  <!-- Which event you are in, said once and permanently, and the way out to
       another one. On the phone this lives in the strip above the content and
       the bar has no room for it; in the rail it is the one thing that should
       never scroll away, so the strip stands down (see .compact-event-strip in
       app.css). -->
  {#if eventShell.ctx}
    <EventSwitcher ctx={eventShell.ctx} {naddr} />
  {/if}
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
      <span class="ico">
        <Icon name="people" size={24} />
        {#if newPeople > 0 && !active("attendees", "attendee")}
          <span class="badge-count" aria-hidden="true">{newPeople > 9 ? "9+" : newPeople}</span>
        {/if}
      </span><span class="lbl"
        >{t("nav.people")}{#if newPeople > 0 && !active("attendees", "attendee")}<span class="visually-hidden"
            >{tp("nav.people.new", newPeople)}</span
          >{/if}</span
      >
    </button>
  {/if}

  {#if eventShell.showTalks && !eventShell.talksFirst}{@render talksTab()}{/if}

  {#if eventShell.showChat}
    <!-- Active on the event group chat AND the global chat list / DM threads
         reached from inside this event (Bug 1): the Chat tab stays lit so the
         user still reads as "in this event" while messaging. -->
    <button
      aria-current={active("chat", "dm", "dmPeer") ? "page" : undefined}
      class:active={active("chat", "dm", "dmPeer")}
      onclick={() => router.go({ name: "chat", naddr })}
    >
      <span class="ico">
        <Icon name="chat" size={24} />
        {#if dmUnread.confirmedCount > 0}
          <span class="badge-count" aria-hidden="true">{dmUnread.confirmedCount > 99 ? "99+" : dmUnread.confirmedCount}</span>
        {:else if dmUnread.hasEncryptedActivity}
          <span class="badge-dot" aria-hidden="true"></span>
        {/if}
      </span><span class="lbl">{t("nav.chat")}{#if dmUnread.confirmedCount > 0}<span class="visually-hidden">{tp("dm.unread", dmUnread.confirmedCount)}</span>{:else if dmUnread.hasEncryptedActivity}<span class="visually-hidden">{t("dm.encryptedActivity")}</span>{/if}</span>
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
  .badge-dot {
    position: absolute;
    top: -4px;
    left: 50%;
    width: 0.5rem;
    height: 0.5rem;
    transform: translate(70%, 20%);
    border-radius: 50%;
    background: var(--accent);
  }
  .lbl {
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── Desktop: the bar becomes a left rail ──────────────────────────────
     A bottom bar is where a thumb already is, which is why it is right on a
     phone and wrong on a monitor: it puts the navigation as far from the
     cursor as the window allows, and stretches five items across a width twice
     that of the content they lead to. Same markup, same order, same badges —
     the axis changes and the labels stop competing for room, which is also what
     retires the 6-tab ellipsis rule above. */
  @media (min-width: 1000px) {
    .event-nav {
      top: 0;
      right: auto;
      width: var(--rail);
      flex-direction: column;
      justify-content: flex-start;
      align-items: stretch;
      gap: 0.1rem;
      padding: 1rem 0.7rem 1.2rem;
      border-top: none;
      border-right: 1px solid var(--border);
      box-shadow: none;
      /* Solid, not translucent. Blur behind a bar floating over scrolling
         content is a real effect; behind a full-height rail beside the content
         it is decoration — and it would create a containing block that traps
         the switcher's fixed menu inside the rail's own scroll. */
      background: var(--bg-elev);
      backdrop-filter: none;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .event-nav button {
      flex: 0 0 auto;
      max-width: none;
      min-height: 40px;
      flex-direction: row;
      justify-content: flex-start;
      gap: 0.7rem;
      padding: 0.5rem 0.65rem 0.5rem 0.85rem;
      border-radius: var(--radius-sm);
    }
    .event-nav button:hover {
      background: var(--bg-elev2);
      color: var(--text);
    }
    .event-nav button.active {
      background: var(--accent-soft);
    }
    /* The selected marker turns with the axis: a bar down the leading edge
       rather than across the top. Still currentColor and still not carried by
       colour alone, so forced-colors keeps it (A6). */
    /* Inside the button, not outside it: the rail scrolls, and a scroll
       container clips both axes, so a marker hung in the rail's padding was
       sliced off at the window edge. */
    .event-nav button.active::before {
      top: 50%;
      left: 0;
      width: 3px;
      height: 1.25rem;
      transform: translateY(-50%);
      border-radius: 0 2px 2px 0;
    }
    .lbl {
      font-size: 0.92rem;
      font-weight: 600;
    }
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
  /* Six tabs is the fullest the bar gets (Overview · Talks · People · Chat ·
     Updates · More). At that count the widest label runs past the ellipsis at
     390px, which is the common phone width AND the one the docs screenshots are
     taken at, so "Overview" shipped as "Overvi…". The rule above never caught it
     because it triggers on a width below 360px, and the cause is not width: five
     tabs fit at 390px perfectly well. Count the tabs instead of guessing at the
     viewport. */
  .event-nav:has(> button:nth-child(6)) .lbl {
    font-size: 0.68rem;
  }
</style>
