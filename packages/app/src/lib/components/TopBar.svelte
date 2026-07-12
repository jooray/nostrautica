<script lang="ts">
  import { theme } from "$lib/stores/theme.svelte.js";
  import { router } from "$lib/router/router.svelte.js";

  function toggleTheme() {
    theme.set(theme.effective === "dark" ? "light" : "dark");
  }

  const showBack = $derived(router.route.name !== "home");
</script>

<header class="topbar">
  <div class="row" style="gap:0.5rem">
    {#if showBack}
      <button class="btn inline" style="width:auto" onclick={() => router.back()} aria-label="Back">
        ‹ Back
      </button>
    {/if}
    <a class="brand" href="#/" aria-label="Nostrautica home">✦ Nostrautica</a>
  </div>
  <button
    class="btn inline"
    style="width:auto"
    onclick={toggleTheme}
    aria-label="Toggle theme"
    title="Toggle theme"
  >
    {theme.effective === "dark" ? "☀" : "☾"}
  </button>
</header>
