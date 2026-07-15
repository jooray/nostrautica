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
  <button aria-current={active("home") ? "page" : undefined} class:active={active("home")} onclick={() => router.go({ name: "home" })}>
    <span class="ico"><Icon name="star" size={24} /></span><span class="lbl">{t("nav.events")}</span>
  </button>
  <button aria-current={active("create") ? "page" : undefined} class:active={active("create")} onclick={() => router.go({ name: "create" })}>
    <span class="ico"><Icon name="plus" size={24} /></span><span class="lbl">{t("nav.create")}</span>
  </button>
  {#if session.loggedIn}
    <button
      aria-current={active("dm") || active("dmPeer") ? "page" : undefined}
      class:active={active("dm") || active("dmPeer")}
      onclick={() => router.go({ name: "dm" })}
    >
      <span class="ico"><Icon name="chat" size={24} /></span><span class="lbl">{t("nav.messages")}</span>
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
    flex: 1;
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
  }
</style>
