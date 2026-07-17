<script lang="ts">
  /**
   * One post in a feed (spec §7.4). Members-only posts the reader can't
   * decrypt render as a lock + join prompt — a non-member learns only that a
   * members-only post exists (accepted metadata, spec §6.6).
   */
  import type { EventPost } from "$lib/events/posts.js";
  import { renderMarkdown } from "$lib/social/markdown.js";
  import { router } from "$lib/router/router.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import Icon from "$lib/components/icons/Icon.svelte";

  let {
    post,
    naddr,
    full = false,
    openable = true,
  }: {
    post: EventPost;
    naddr: string;
    /** Render the whole markdown body instead of a summary + read link. */
    full?: boolean;
    /** Whether the card links to the dedicated post viewer. False on the post
     *  page itself (a self-link would be pointless). */
    openable?: boolean;
  } = $props();

  function open() {
    router.go({ name: "post", naddr, d: post.d });
  }
</script>

<article class="card">
  {#if post.locked}
    <div class="row" style="justify-content:space-between;align-items:baseline">
      <h3 style="margin:0;display:flex;align-items:center;gap:0.4rem"><Icon name="lock" size={18} /> {t("post.locked.title")}</h3>
      <span class="badge">{t("post.membersBadge")}</span>
    </div>
    <p class="muted" style="margin:0.25rem 0 0.5rem">{t("post.locked.body")}</p>
    <button class="btn inline primary" onclick={() => router.go({ name: "join", naddr })}>
      {t("post.locked.join")}
    </button>
  {:else}
    <div class="row" style="justify-content:space-between;align-items:baseline">
      <h3 style="margin:0">
        {#if openable}<button class="linkish" onclick={open}>{post.title}</button>{:else}{post.title}{/if}
      </h3>
      <span class="muted" style="font-size:0.75rem;flex:none">
        {new Date(post.publishedAt * 1000).toLocaleDateString()}
        {#if post.editedAt > post.publishedAt}{t("post.edited")}{/if}
      </span>
    </div>
    <div class="row" style="flex-wrap:wrap;gap:0.25rem">
      {#if post.membersOnly}<span class="badge">{t("post.membersBadge")}</span>{/if}
      {#if post.source === "attendees"}<span class="badge">{t("post.attendeeBadge")}</span>{/if}
    </div>
    {#if post.image && full}
      <img class="header-img" src={post.image} alt="" loading="lazy" />
    {/if}
    {#if full}
      <!-- Safe: renderMarkdown escapes the source before emitting its own tags. -->
      <div class="longform">{@html renderMarkdown(post.content)}</div>
      {#if openable}
        <!-- A `full` card in a feed is a preview — give it an explicit way into
             the dedicated post viewer (user feedback 2026-07-17). -->
        <button class="btn inline open-post" onclick={open}>{t("post.open")}</button>
      {/if}
    {:else}
      {#if post.summary}
        <p class="muted" style="margin:0.25rem 0">{post.summary}</p>
      {/if}
      <button class="btn inline" onclick={open}>{t("post.read")}</button>
    {/if}
  {/if}
</article>

<style>
  .linkish {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    text-align: left;
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
  }
  .header-img {
    max-width: 100%;
    border-radius: var(--radius-sm);
    margin: 0.5rem 0;
  }
  .open-post {
    margin-top: 0.5rem;
  }
  .longform :global(p) {
    margin: 0.5rem 0;
  }
  .longform :global(ul),
  .longform :global(ol) {
    margin: 0.5rem 0;
    padding-left: 1.25rem;
  }
  .longform :global(h3),
  .longform :global(h4),
  .longform :global(h5) {
    margin: 0.75rem 0 0.25rem;
  }
  .longform :global(img) {
    max-width: 100%;
    border-radius: var(--radius-sm);
  }
  .longform :global(pre) {
    overflow-x: auto;
    padding: 0.5rem;
    background: var(--bg-elev2);
    border-radius: var(--radius-sm);
  }
  .longform :global(.md-table) {
    overflow-x: auto;
  }
  .longform :global(table) {
    border-collapse: collapse;
  }
  .longform :global(th),
  .longform :global(td) {
    border: 1px solid var(--border);
    padding: 0.25rem 0.5rem;
    text-align: left;
  }
</style>
