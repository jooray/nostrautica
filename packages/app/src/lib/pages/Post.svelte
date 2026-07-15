<script lang="ts">
  /**
   * `#/e/:naddr/posts/:d` (spec §10.1): one post, resolved 30023-by-d then
   * 31607-by-d, keeping the highest created_at across both kinds. A
   * members-only post without the ECK renders a lock + join prompt.
   */
  import { onMount } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import {
    loadEventContext,
    cachedEventContext,
    type EventContext,
  } from "$lib/events/event-context.js";
  import { receiveGrants } from "$lib/events/attendee.js";
  import { fetchPostByD, type EventPost } from "$lib/events/posts.js";
  import PostCard from "$lib/components/PostCard.svelte";
  import { router } from "$lib/router/router.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { naddr, d }: { naddr: string; d: string } = $props();

  let ctx = $state<EventContext | null>(cachedEventContext(naddr) ?? null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let post = $state<EventPost | undefined>(undefined);

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      if (session.signer) await receiveGrants(session.signer).catch(() => {});
      post = await fetchPostByD(ctx, d);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  });
</script>

{#if error}
  <div class="card warn">
    <strong>{t("event.loadFailed")}</strong>
    <span class="muted">{error}</span>
  </div>
{:else}
  {#if loading}
    <p class="muted">{t("posts.loading")}</p>
  {:else if !post}
    <div class="card">
      <p style="margin:0"><strong>{t("post.notFound")}</strong></p>
      <p class="muted">{t("post.notFound.body")}</p>
      <button class="btn inline" onclick={() => router.go({ name: "posts", naddr })}>
        {t("post.allPosts")}
      </button>
    </div>
  {:else}
    <PostCard {post} {naddr} full />
    <button class="btn inline" onclick={() => router.go({ name: "posts", naddr })}>
      {t("post.allPosts")}
    </button>
  {/if}
{/if}
