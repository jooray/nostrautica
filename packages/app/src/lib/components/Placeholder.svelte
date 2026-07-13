<script lang="ts">
  import { t } from "$lib/i18n/i18n.svelte.js";
  let { title, phase }: { title: string; phase: string } = $props();
</script>

<h1>{title}</h1>
<div class="card">
  <p class="muted">{@html t("placeholder.arrives", { phase: `<strong>${phase}</strong>` })}</p>
</div>
