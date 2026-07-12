<script lang="ts">
  import { router } from "$lib/router/router.svelte.js";
  import { session } from "$lib/signer/session.svelte.js";

  const route = $derived(router.route);
  function active(name: string) {
    return route.name === name;
  }
</script>

<nav class="bottom-nav">
  <button class:active={active("home")} onclick={() => router.go({ name: "home" })}>
    <span class="ico">🏠</span><span class="lbl">Events</span>
  </button>
  <button class:active={active("create")} onclick={() => router.go({ name: "create" })}>
    <span class="ico">＋</span><span class="lbl">Create</span>
  </button>
  <button
    class:active={active("me")}
    onclick={() => router.go({ name: session.loggedIn ? "me" : "login" })}
  >
    <span class="ico">👤</span><span class="lbl">{session.loggedIn ? "Me" : "Log in"}</span>
  </button>
  <button class:active={active("settings")} onclick={() => router.go({ name: "settings" })}>
    <span class="ico">⚙</span><span class="lbl">Settings</span>
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
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter: blur(10px);
    border-top: 1px solid var(--border);
  }
  button {
    flex: 1;
    max-width: 6rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.1rem;
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
  }
  .ico {
    font-size: 1.15rem;
    line-height: 1;
  }
  .lbl {
    font-size: 0.7rem;
    font-weight: 600;
  }
</style>
