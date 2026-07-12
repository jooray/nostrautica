<script lang="ts">
  import { theme } from "$lib/stores/theme.svelte.js";

  function toggleTheme() {
    theme.set(theme.effective === "dark" ? "light" : "dark");
  }
</script>

<header class="topbar">
  <a class="brand" href="#/" aria-label="Nostrautica home">✦ Nostrautica</a>
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
