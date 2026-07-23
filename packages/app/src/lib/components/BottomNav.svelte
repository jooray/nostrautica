<script lang="ts">
  import { router } from "$lib/router/router.svelte.js";
  import { session } from "$lib/signer/session.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import Icon from "$lib/components/icons/Icon.svelte";

  const route = $derived(router.route);
  function active(name: string) {
    return route.name === name;
  }
</script>

<nav class="bottom-nav" aria-label={t("nav.primary")}>
  <!-- "Create" dropped from the tab bar (user feedback 2026-07-20): very few
       people create an event, and Home already offers it prominently (empty
       state, "create another", zero-events state) — a whole tab slot for a
       rare action crowded out the ones people actually reach for daily. -->
  <button aria-current={active("home") ? "page" : undefined} class:active={active("home")} onclick={() => router.go({ name: "home" })}>
    <span class="ico"><Icon name="star" size={24} /></span><span class="lbl">{t("nav.events")}</span>
  </button>
  {#if session.loggedIn}
    <!-- "Chat" — unified group-chats + DMs (user feedback 2026-07-20: this
         used to be DM-only "Messages" and disappeared entirely inside an
         event since EventNav replaces this bar there; same label as
         EventNav's own Chat tab now, since they lead to the same place. -->
    <button
      aria-current={active("dm") || active("dmPeer") ? "page" : undefined}
      class:active={active("dm") || active("dmPeer")}
      onclick={() => router.go({ name: "dm" })}
    >
      <span class="ico"><Icon name="chat" size={24} /></span><span class="lbl">{t("nav.chat")}</span>
    </button>
  {/if}
  <button
    aria-current={active("me") ? "page" : undefined}
    class:active={active("me")}
    onclick={() => router.go({ name: session.loggedIn ? "me" : "login" })}
  >
    <span class="ico"><Icon name="person" size={24} /></span><span class="lbl">{session.loggedIn ? t("nav.me") : t("nav.login")}</span>
  </button>
  <button aria-current={active("settings") ? "page" : undefined} class:active={active("settings")} onclick={() => router.go({ name: "settings" })}>
    <span class="ico"><Icon name="sliders" size={24} /></span><span class="lbl">{t("nav.settings")}</span>
  </button>
</nav>

<style>
  .bottom-nav {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 20;
    display: flex;
    justify-content: space-around;
    gap: 0.25rem;
    padding: 0.35rem 0.5rem calc(0.35rem + env(safe-area-inset-bottom));
    background: color-mix(in srgb, var(--bg-raised) 92%, transparent);
    backdrop-filter: blur(10px);
    box-shadow: var(--shadow-raised);
    border-top: 1px solid var(--border);
  }
  button {
    position: relative;
    flex: 1 1 0;
    /* Shrink below content so labels never force horizontal overflow (§7.4.8). */
    min-width: 0;
    max-width: 6rem;
    min-height: var(--nav-target);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.15rem;
    background: none;
    border: none;
    color: var(--text-dim);
    font: inherit;
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 10px;
  }
  button.active {
    color: var(--accent);
    font-weight: 700;
  }
  /* Non-color selected marker (A6): a top bar so the active item is identifiable
     without relying on color alone (including forced-colors mode). */
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
  }
  .lbl {
    font-size: 0.75rem;
    font-weight: 600;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (max-width: 360px) {
    .lbl {
      font-size: 0.68rem;
    }
  }
</style>
