<script lang="ts">
  import "$lib/styles/app.css";
  import { onMount } from "svelte";
  import { router } from "$lib/router/router.svelte.js";
  import { theme } from "$lib/stores/theme.svelte.js";
  import { i18n } from "$lib/i18n/i18n.svelte.js";
  import { session, consumeNsecFromHash } from "$lib/signer/session.svelte.js";
  import { online } from "$lib/stores/online.svelte.js";
  import { installQueueFlusher, flushQueue } from "$lib/nostr/publish-queue.js";
  import { registerPwa } from "$lib/pwa.js";
  import TopBar from "$lib/components/TopBar.svelte";

  let { children } = $props();
  let booted = $state(false);

  onMount(async () => {
    theme.init();
    i18n.init();
    online.init();
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
  {#if !online.isOnline}
    <div class="card warn" style="margin:0.5rem 0">
      Offline — you can still browse cached people and matches; changes will sync
      when you reconnect.
    </div>
  {/if}
  {#if booted}
    {@render children()}
  {:else}
    <p class="muted" style="margin-top:2rem">Loading…</p>
  {/if}
</div>
