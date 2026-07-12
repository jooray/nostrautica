<script lang="ts">
  import { theme, type ThemePref } from "$lib/stores/theme.svelte.js";

  const options: { value: ThemePref; label: string }[] = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];
</script>

<h1>Settings</h1>

<div class="card">
  <div class="field-label">Theme</div>
  <div class="row">
    {#each options as o (o.value)}
      <button
        class="btn inline"
        class:primary={theme.pref === o.value}
        onclick={() => theme.set(o.value)}
      >
        {o.label}
      </button>
    {/each}
  </div>
</div>

<div class="card">
  <div class="field-label">Language</div>
  <p class="muted">English (Slovak coming in a later phase).</p>
</div>
