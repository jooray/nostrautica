<script lang="ts">
  import { router } from "$lib/router/router.svelte.js";
</script>

<h1>Not found</h1>
<p class="muted">That page doesn't exist.</p>
<button class="btn primary" onclick={() => router.go({ name: "home" })}>Go home</button>
