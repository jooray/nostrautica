<script lang="ts">
  import "$lib/styles/app.css";
  import { onMount } from "svelte";
  import { router } from "$lib/router/router.svelte.js";
  import { theme } from "$lib/stores/theme.svelte.js";
  import { session, consumeNsecFromHash } from "$lib/signer/session.svelte.js";
  import { installQueueFlusher, flushQueue } from "$lib/nostr/publish-queue.js";
  import { registerPwa } from "$lib/pwa.js";
  import TopBar from "$lib/components/TopBar.svelte";

  let { children } = $props();
  let booted = $state(false);

  onMount(async () => {
    theme.init();
    router.init();
    // Consume any nsec carried in #/login?nsec= and strip it from history first.
    await consumeNsecFromHash();
    if (!session.loggedIn) await session.restore().catch(() => {});
    installQueueFlusher();
    void flushQueue();
    registerPwa();
    booted = true;
  });
</script>

<div class="app-shell">
  <TopBar />
  {#if booted}
    {@render children()}
  {:else}
    <p class="muted" style="margin-top:2rem">Loading…</p>
  {/if}
</div>
