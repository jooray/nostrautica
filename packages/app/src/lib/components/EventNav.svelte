<script lang="ts">
  // Event-scoped nav (redesign §6.2). On a phone it is a bottom bar —
  // Overview · People · Updates · More; on a desktop it is a left rail.
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
  import { viewport } from "$lib/stores/viewport.svelte.js";
  import Icon from "$lib/components/icons/Icon.svelte";
  import Avatar from "$lib/components/Avatar.svelte";
  import EventSwitcher from "$lib/components/EventSwitcher.svelte";
  import { dmUnread } from "$lib/stores/dm-unread.svelte.js";
  import { moreRows } from "$lib/components/more-rows.js";
  import { cachedProfiles, fetchProfiles, type ProfileMeta } from "$lib/events/social.js";
  import { connectivity } from "$lib/stores/connectivity.svelte.js";

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

  // ── Phone bar vs desktop rail ────────────────────────────────────────────
  // The bar holds Overview · People · Chat · Updates · More — five at most, one
  // fewer than before the People/Matches merge. That is what let Updates come
  // back out of the More menu: it used to collapse there whenever Matches AND
  // Chat were both visible (MARMOT-GROUP-CHAT §7) because six tabs squeezed the
  // labels to the point of truncating ("Overvi…"). Five fit.
  //
  // The rail has no such shortage: it is as tall as the window and the items
  // are one per line, so the whole More menu is rendered inline and the More
  // tab does not exist up there at all (user feedback 2026-09-20 — "there's
  // plenty of space"). A tab that means "the rest of the navigation is behind
  // here" only earns its slot where slots are scarce.
  //
  // Rendered by a media-query RUNE rather than shown/hidden in CSS, because the
  // difference is structural: the same destination must not be in the DOM twice
  // (Messages as a rail row and as a More row), and Chat's active range differs
  // between the two — see chatHere.
  const rail = $derived(viewport.wide);
  const rows = $derived(
    rail
      ? moreRows({
          naddr,
          isMember: eventShell.isMember,
          isOrganizer: eventShell.isOrganizer,
          loggedIn: session.loggedIn,
        })
      : [],
  );
  // On the phone, a DM opened from inside an event keeps the Chat tab lit so the
  // user still reads as "in this event" while messaging (Bug 1). In the rail
  // that would light two items at once, because Messages is a row of its own.
  const chatHere = $derived(rail ? ["chat"] : ["chat", "dm", "dmPeer"]);
  // Overview + Updates + More, plus whatever else this event turns on. Counted
  // here rather than in CSS: see the .tight note in the stylesheet.
  const tabCount = $derived(
    3 +
      (eventShell.showTalks ? 1 : 0) +
      (eventShell.showPeople ? 1 : 0) +
      (eventShell.showChat ? 1 : 0),
  );

  // The rail's account row shows the real photo and display name. The More tab
  // it replaces passed neither to Avatar, which is why it drew two characters of
  // the npub.
  //
  // Two rules, both learned the hard way in a desktop e2e run where the row sat
  // on "Your identity" forever with the kind-0 sitting on the relay all along:
  //
  //  - Paint from the cache first, with no network at all. A returning user's
  //    own profile is already there and the row should never flash a placeholder.
  //  - Ask relays only once one is actually CONNECTED. The rail mounts with the
  //    event page, which is early enough that connectNdk() has resolved but no
  //    socket is open yet; the stream then EOSEs empty off the local cache — and
  //    fetchProfiles stamps every pubkey it asked about, so that empty answer
  //    would stick for the next ten minutes. `force` is for the same reason:
  //    some earlier caller's equally early attempt may already have stamped it.
  let me = $state<ProfileMeta | undefined>(undefined);
  let asked = "";
  $effect(() => {
    const pk = session.pubkey;
    const connected = connectivity.relay === "connected";
    if (!rail || !pk) return;
    const cached = cachedProfiles([pk]).get(pk);
    if (cached) me = cached;
    if (!connected || asked === pk) return;
    asked = pk;
    void (async () => {
      const found = (await fetchProfiles([pk], { force: true }).catch(() => new Map())).get(pk);
      if (found) me = found;
    })();
  });
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

<nav class="event-nav" class:tight={tabCount >= 6} aria-label={t("nav.eventPrimary")}>
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
    <button
      aria-current={active(...chatHere) ? "page" : undefined}
      class:active={active(...chatHere)}
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

  {#if !rail}
    <button
      aria-current={active("eventMore") ? "page" : undefined}
      class:active={active("eventMore")}
      onclick={() => router.go({ name: "eventMore", naddr })}
    >
      <span class="ico"><Icon name="ellipsis" size={24} /></span><span class="lbl">{t("nav.more")}</span>
    </button>
  {:else}
    <!-- The More menu, inline. Same rows, same order, same gating as the More
         page renders on a phone — one list, two surfaces (components/more-rows). -->
    <div class="rail-rule" aria-hidden="true"></div>
    {#each rows as r (r.go.name)}
      <button
        aria-current={active(...r.here) ? "page" : undefined}
        class:active={active(...r.here)}
        onclick={() => router.go(r.go)}
      >
        <span class="ico"><Icon name={r.icon} size={24} /></span><span class="lbl">{r.label}</span>
      </button>
    {/each}

    <!-- Who you are signed in as, at the foot of the rail: the one part of the
         More page that is an identity rather than a destination. It hands off to
         the same global profile page the card on that page does. -->
    <div class="rail-rule foot" aria-hidden="true"></div>
    {#if session.loggedIn && session.pubkey}
      <button
        class="account"
        aria-current={active("me") ? "page" : undefined}
        class:active={active("me")}
        onclick={() => router.go({ name: "me" })}
      >
        <span class="ico"><Avatar pubkey={session.pubkey} name={me?.name} picture={me?.picture} size={24} /></span
        ><span class="lbl">{me?.name || t("more.identity")}</span>
      </button>
    {:else}
      <button class="account" onclick={() => router.go({ name: "login" })}>
        <span class="ico"><Icon name="person" size={24} /></span><span class="lbl">{t("nav.login")}</span>
      </button>
    {/if}
  {/if}
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
  /* Rail-only elements; they are never rendered in the bar. */
  .rail-rule {
    display: none;
  }

  /* ── Desktop: the bar becomes a left rail ──────────────────────────────
     A bottom bar is where a thumb already is, which is why it is right on a
     phone and wrong on a monitor: it puts the navigation as far from the
     cursor as the window allows, and stretches five items across a width twice
     that of the content they lead to. Same markup, same order, same badges —
     the axis changes, the labels stop competing for room, and the More menu
     unfolds into the space that buys. */
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
      /* Beside an icon rather than under it, a label has to be allowed to
         shrink or a long display name widens the rail's scroll box. */
      min-width: 0;
      /* …and then to WRAP rather than be cut off. The bar truncates because a
         tab is one slot wide and nothing can be done about it; the rail has a
         whole line per item and 232px of it, which "Create an event or
         community" (and its German translation, half again as long) does not
         fit on. A second line costs 20px and says the whole thing. */
      white-space: normal;
      overflow: visible;
      overflow-wrap: anywhere;
      line-height: 1.25;
      text-align: left;
    }
    /* Primary destinations, then the menu, then who you are. Two hairlines
       instead of one because the account row is not a third group of links —
       it is the end of the rail. */
    .rail-rule {
      display: block;
      flex: none;
      height: 1px;
      margin: 0.6rem 0.2rem;
      background: var(--border);
    }
    /* Sinks the account row to the foot of the window when the rail is shorter
       than the viewport; when it is taller, an auto margin resolves to zero and
       the row simply follows the list. */
    .rail-rule.foot {
      margin-top: auto;
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
  /* Six tabs is the fullest the BAR gets (Overview · Talks · People · Chat ·
     Updates · More). At that count the widest label runs past the ellipsis at
     390px, which is the common phone width AND the one the docs screenshots are
     taken at, so "Overview" shipped as "Overvi…". The rule that preceded this
     one counted tabs in CSS — `:has(> button:nth-child(6))` — and got it wrong
     twice over: the event switcher is a child too, so it fired at five tabs,
     and being more specific than the rail's own .lbl rule it shrank the DESKTOP
     labels as well. Count the tabs in script, and confine the result to the
     viewport where the bar actually exists. */
  @media (max-width: 999px) {
    .event-nav.tight .lbl {
      font-size: 0.68rem;
    }
  }
</style>
