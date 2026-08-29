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
  import { fetchPostByD, cachedPostByD, type EventPost } from "$lib/events/posts.js";
  import { fetchEventPage, cachedEventPage } from "$lib/events/event-page.js";
  import PostCard from "$lib/components/PostCard.svelte";
  import { router } from "$lib/router/router.svelte.js";
  import { perfMark } from "$lib/perf.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { naddr, d }: { naddr: string; d: string } = $props();

  // svelte-ignore state_referenced_locally -- naddr is constant for this instance ({#key} remounts on change)
  const cachedCtx = cachedEventContext(naddr);
  let ctx = $state<EventContext | null>(cachedCtx ?? null);
  let error = $state<string | null>(null);
  // Cache-first (§2.4): paint the post from the cached feeds instantly instead
  // of always round-tripping, then refresh in the background.
  // svelte-ignore state_referenced_locally -- d is constant for this instance ({#key} remounts on change)
  let post = $state<EventPost | undefined>(
    cachedCtx ? cachedPostByD(cachedCtx.coordinate, d) : undefined,
  );
  // svelte-ignore state_referenced_locally -- intentional one-time read of the initial cache-painted value
  let loading = $state(post === undefined);
  // svelte-ignore state_referenced_locally -- intentional one-time read of the initial cache-painted value
  if (post) perfMark("Post", "cache-paint");

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      if (post === undefined) post = cachedPostByD(ctx.coordinate, d);
      if (session.signer) await receiveGrants(session.signer).catch(() => {});
      // A curated article (31608 `sources`) isn't authored by E_id, so resolving
      // it by `d` needs the declared feeds. Cheap when they're already cached,
      // and the read still works — from the event's own posts — if the page
      // fetch fails.
      const sources =
        (await fetchEventPage(ctx).catch(() => cachedEventPage(ctx!.coordinate)))?.sources ??
        [];
      const fresh = await fetchPostByD(ctx, d, sources);
      if (fresh) post = fresh;
    } catch (e) {
      if (!post) error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
      perfMark("Post", "network-settled");
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
    <PostCard {post} {naddr} full openable={false} />
    <button class="btn inline" onclick={() => router.go({ name: "posts", naddr })}>
      {t("post.allPosts")}
    </button>
  {/if}
{/if}
