<script lang="ts">
  /**
   * `#/e/:naddr/posts` (spec §8 "Read posts", §10.1): the event's blog feed
   * with filter controls mirroring the 31608 section config — source:
   * event-official / attendees / both; visibility: public / members-only /
   * both. Everyone sees only what they can decrypt regardless of filters.
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
  import {
    fetchEventPosts,
    fetchAttendeePosts,
    cachedEventPosts,
    cachedAttendeePosts,
    type EventPost,
  } from "$lib/events/posts.js";
  import PostCard from "$lib/components/PostCard.svelte";
  import { perfMark } from "$lib/perf.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { naddr }: { naddr: string } = $props();

  // svelte-ignore state_referenced_locally -- naddr is constant for this instance ({#key} remounts on change)
  const cachedCtx = cachedEventContext(naddr);
  let ctx = $state<EventContext | null>(cachedCtx ?? null);
  let error = $state<string | null>(null);
  // Cache-first: paint posts already fetched (event home / prefetch) instantly,
  // then refresh in the background. Only show the spinner on a cold open.
  let eventPosts = $state<EventPost[]>(
    (cachedCtx && cachedEventPosts(cachedCtx.coordinate)) ?? [],
  );
  let attendeePosts = $state<EventPost[]>(
    (cachedCtx && cachedAttendeePosts(cachedCtx.coordinate)) ?? [],
  );
  // svelte-ignore state_referenced_locally -- intentional one-time read of the initial cache-painted values
  let loading = $state(eventPosts.length === 0 && attendeePosts.length === 0);
  // svelte-ignore state_referenced_locally -- intentional one-time read of the initial cache-painted value
  if (!loading) perfMark("Posts", "cache-paint");

  let source = $state<"event" | "attendees" | "both">("both");
  let visibility = $state<"public" | "members" | "both">("both");

  const posts = $derived.by(() => {
    let list: EventPost[] = [];
    if (source !== "attendees") list = list.concat(eventPosts);
    if (source !== "event") list = list.concat(attendeePosts);
    if (visibility === "public") list = list.filter((p) => !p.membersOnly);
    if (visibility === "members") list = list.filter((p) => p.membersOnly);
    return list.sort((a, b) => b.publishedAt - a.publishedAt);
  });

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      // Populate cached posts for the resolved coordinate before the network
      // returns (covers the cold-context case where cachedCtx was null above).
      if (eventPosts.length === 0) eventPosts = cachedEventPosts(ctx.coordinate) ?? [];
      if (attendeePosts.length === 0) attendeePosts = cachedAttendeePosts(ctx.coordinate) ?? [];
      if (eventPosts.length || attendeePosts.length) loading = false;
      // Fold in any pending ECK grants so members-only posts decrypt.
      if (session.signer) await receiveGrants(session.signer).catch(() => {});
      const [ev, att] = await Promise.all([
        fetchEventPosts(ctx).catch(() => eventPosts),
        fetchAttendeePosts(ctx).catch(() => attendeePosts),
      ]);
      eventPosts = ev;
      attendeePosts = att;
    } catch (e) {
      if (eventPosts.length === 0 && attendeePosts.length === 0)
        error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
      perfMark("Posts", "network-settled");
    }
  });
</script>

{#if error}
  <div class="card warn">
    <strong>{t("event.loadFailed")}</strong>
    <span class="muted">{error}</span>
  </div>
{:else}
  <h1>{t("posts.title")}</h1>

  <div class="row filters">
    <label class="stack" style="gap:0.25rem">
      <span class="field-label">{t("posts.filter.source")}</span>
      <select bind:value={source}>
        <option value="both">{t("posts.filter.both")}</option>
        <option value="event">{t("posts.filter.source.event")}</option>
        <option value="attendees">{t("posts.filter.source.attendees")}</option>
      </select>
    </label>
    <label class="stack" style="gap:0.25rem">
      <span class="field-label">{t("posts.filter.visibility")}</span>
      <select bind:value={visibility}>
        <option value="both">{t("posts.filter.both")}</option>
        <option value="public">{t("post.editor.public")}</option>
        <option value="members">{t("post.editor.members")}</option>
      </select>
    </label>
  </div>

  {#if loading}
    <p class="muted">{t("posts.loading")}</p>
  {:else if posts.length === 0}
    <p class="muted">{t("posts.none")}</p>
  {:else}
    {#each posts as post (post.source + post.authorPubkey + post.d)}
      <PostCard {post} {naddr} />
    {/each}
  {/if}
{/if}

<style>
  .filters {
    align-items: end;
    flex-wrap: wrap;
  }
  .filters select {
    min-width: 9rem;
  }
</style>
