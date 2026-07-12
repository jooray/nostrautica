<script lang="ts">
  import { session } from "$lib/signer/session.svelte.js";
  import { theme } from "$lib/stores/theme.svelte.js";
  import { router } from "$lib/router/router.svelte.js";

  function toggleTheme() {
    theme.set(theme.effective === "dark" ? "light" : "dark");
  }
</script>

<header class="topbar">
  <a class="brand" href="#/" aria-label="Nostrautica home">✦ Nostrautica</a>
  <div class="row">
    <button
      class="btn inline"
      onclick={toggleTheme}
      aria-label="Toggle theme"
      title="Toggle theme"
    >
      {theme.effective === "dark" ? "☀" : "☾"}
    </button>
    {#if session.loggedIn}
      <button class="btn inline" onclick={() => router.go({ name: "me" })}>Me</button>
    {:else}
      <button class="btn inline primary" onclick={() => router.go({ name: "login" })}>
        Log in
      </button>
    {/if}
  </div>
</header>
