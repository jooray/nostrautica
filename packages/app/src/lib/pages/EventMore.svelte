<script lang="ts">
  // The "More" tab as a route (redesign §6.3): identity handoff, messages,
  // organizer admin, global navigation, settings and the event-privacy pointer.
  // A route (not a sheet) so the hash router, A2 focus/title machinery and the
  // Android back button all work for free.
  import { router } from "$lib/router/router.svelte.js";
  import { session } from "$lib/signer/session.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import { eventShell } from "$lib/stores/event-shell.svelte.js";
  import Icon from "$lib/components/icons/Icon.svelte";
  import Avatar from "$lib/components/Avatar.svelte";
  import type { IconName } from "$lib/components/icons/paths.js";
  import type { Route } from "$lib/router/routes.js";

  let { naddr }: { naddr: string } = $props();

  const npubShort = $derived(session.npub ? session.npub.slice(0, 14) + "…" : "");

  type Row = { icon: IconName; label: string; go: Route };
  const rows = $derived.by(() => {
    const list: Row[] = [];
    if (eventShell.isMember) {
      list.push({ icon: "person", label: t("profile.mine.title"), go: { name: "myProfile", naddr } });
    }
    // When Matches AND Chat are both in the nav, Updates collapses off the bar
    // (EventNav §7) — surface it here so it stays reachable.
    if (eventShell.showMatches && eventShell.showChat) {
      list.push({ icon: "horn", label: t("nav.updates"), go: { name: "posts", naddr } });
    }
    if (session.loggedIn) {
      list.push({ icon: "chat", label: t("nav.messages"), go: { name: "dm" } });
    }
    if (eventShell.isOrganizer) {
      list.push({ icon: "sliders", label: t("more.manageEvent"), go: { name: "admin", naddr } });
    }
    list.push({ icon: "star", label: t("more.allEvents"), go: { name: "home" } });
    list.push({ icon: "plus", label: t("more.createEvent"), go: { name: "create" } });
    list.push({ icon: "sliders", label: t("nav.settings"), go: { name: "settings" } });
    return list;
  });
</script>

<h1>{t("nav.more")}</h1>

<button
  class="card row identity"
  onclick={() => router.go({ name: session.loggedIn ? "me" : "login" })}
>
  {#if session.loggedIn && session.pubkey}
    <Avatar pubkey={session.pubkey} size={44} />
    <span class="idmeta">
      <strong>{t("more.identity")}</strong>
      <span class="muted mono">{npubShort}</span>
    </span>
  {:else}
    <span class="ico-wrap"><Icon name="person" size={24} /></span>
    <span class="idmeta"><strong>{t("nav.login")}</strong></span>
  {/if}
  <span class="chev"><Icon name="arrowUpRight" size={18} /></span>
</button>

<div class="card list">
  {#each rows as r (r.label)}
    <button class="rowlink" onclick={() => router.go(r.go)}>
      <span class="ico-wrap"><Icon name={r.icon} size={22} /></span>
      <span class="rlabel">{r.label}</span>
      <span class="chev"><Icon name="arrowUpRight" size={16} /></span>
    </button>
  {/each}
</div>

<div class="card privacy">
  <strong>{t("more.eventPrivacy")}</strong>
  <p class="muted">{t("more.eventPrivacy.body")}</p>
  <button class="btn inline" onclick={() => router.go({ name: "join", naddr })}>
    {t("more.eventPrivacy.link")}
  </button>
</div>

<style>
  .identity {
    text-align: left;
    cursor: pointer;
    gap: 0.75rem;
    align-items: center;
    width: 100%;
  }
  .idmeta {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    flex: 1;
    min-width: 0;
  }
  .idmeta .mono {
    font-size: 0.78rem;
  }
  .list {
    padding: 0.25rem 0.4rem;
  }
  .rowlink {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    min-height: 48px;
    padding: 0.55rem 0.7rem;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: inherit;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
  }
  .rowlink:hover {
    background: var(--accent-soft);
  }
  .rlabel {
    flex: 1;
    min-width: 0;
  }
  .ico-wrap {
    display: grid;
    place-items: center;
    color: var(--text-dim);
    flex: none;
  }
  .chev {
    color: var(--text-dim);
    flex: none;
  }
  .privacy p {
    margin: 0.35rem 0 0.75rem;
  }
</style>
