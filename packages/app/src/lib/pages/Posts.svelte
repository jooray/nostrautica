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
    type EventPost,
  } from "$lib/events/posts.js";
  import PostCard from "$lib/components/PostCard.svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { naddr }: { naddr: string } = $props();

  let ctx = $state<EventContext | null>(cachedEventContext(naddr) ?? null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let eventPosts = $state<EventPost[]>([]);
  let attendeePosts = $state<EventPost[]>([]);

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
      // Fold in any pending ECK grants so members-only posts decrypt.
      if (session.signer) await receiveGrants(session.signer).catch(() => {});
      const [ev, att] = await Promise.all([
        fetchEventPosts(ctx).catch(() => []),
        fetchAttendeePosts(ctx).catch(() => []),
      ]);
      eventPosts = ev;
      attendeePosts = att;
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
