<script lang="ts">
  /**
   * Communicate domain (Phase 5A/5C carry-over b — Admin domain split). Owns the
   * whole "announce" surface: the post composer's draft state, the published-post
   * list, and the publish/edit actions. Follows the AdminTalks template — the
   * component owns its interaction state and fetches its own posts (seeded from the
   * parent's cache), reporting failures up via `onError`. The parent no longer
   * carries any post state.
   */
  import { onMount } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import type { EventContext } from "$lib/events/event-context.js";
  import {
    fetchEventPosts,
    publishMembersPost,
    type EventPost,
    type PostVisibility,
  } from "$lib/events/posts.js";
  import { publishEventUpdate } from "$lib/events/updates.js";
  import PostEditor from "./PostEditor.svelte";
  import { saveFormDraft, loadFormDraft, clearDraft } from "$lib/stores/drafts.js";
  import { opStatus } from "$lib/stores/op-status.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let {
    ctx,
    initialPosts = [],
    onError,
  }: {
    ctx: EventContext;
    /** Cached posts to paint immediately while the fresh set loads. */
    initialPosts?: EventPost[];
    onError: (message: string) => void;
  } = $props();

  // svelte-ignore state_referenced_locally -- initialPosts is a paint-once cache prop; live updates come via load()
  let posts = $state<EventPost[]>(initialPosts);
  let postTitle = $state("");
  let postSummary = $state("");
  let postImage = $state("");
  let postContent = $state("");
  let postVisibility = $state<PostVisibility>("public");
  let postEditing = $state<EventPost | null>(null); // null = new post
  let postBusy = $state(false);
  // Durable draft for an UNSENT new post (audit U9): survives a reload/crash, not
  // just a deferred SW refresh. Owner-scoped + per-event; wiped on logout.
  const draftId = $derived(`post:${ctx.coordinate}`);
  let restoredDraft = $state(false);

  async function loadUpdates() {
    posts = await fetchEventPosts(ctx).catch(() => posts);
  }

  onMount(() => {
    // Restore an unsent new-post draft before loading the published list.
    const d = loadFormDraft<{ title: string; summary: string; image: string; content: string }>(
      draftId,
    );
    if (d && (d.title?.trim() || d.content?.trim())) {
      postTitle = d.title ?? "";
      postSummary = d.summary ?? "";
      postImage = d.image ?? "";
      postContent = d.content ?? "";
      restoredDraft = true;
    }
    void loadUpdates();
  });

  // Persist the new-post composer as the organizer types (U9). Only for a NEW
  // post — editing a published post loads from that post, not the draft store.
  $effect(() => {
    if (postEditing !== null) return;
    saveFormDraft(draftId, {
      title: postTitle,
      summary: postSummary,
      image: postImage,
      content: postContent,
    });
  });

  function discardDraft() {
    resetEditor();
    clearDraft(draftId);
    restoredDraft = false;
  }

  function startEdit(p: EventPost) {
    postEditing = p;
    postTitle = p.title;
    postSummary = p.summary ?? "";
    postImage = p.image ?? "";
    postContent = p.content;
    // Visibility is fixed at creation (spec §7.4) — reflected + locked in the editor.
    postVisibility = p.membersOnly ? "members" : "public";
  }

  function resetEditor() {
    postEditing = null;
    postTitle = "";
    postSummary = "";
    postImage = "";
    postContent = "";
    postVisibility = "public";
  }

  async function publishPost() {
    if (!postTitle.trim() || !postContent.trim()) return;
    postBusy = true;
    try {
      const base = {
        d: postEditing?.d,
        publishedAt: postEditing?.publishedAt,
        title: postTitle.trim(),
        summary: postSummary.trim() || undefined,
        image: postImage.trim() || undefined,
        content: postContent,
      };
      const outcome =
        postVisibility === "members"
          ? (
              await publishMembersPost(ctx, {
                ...base,
                // Optional attribution: which organizer wrote it (inside the ciphertext).
                author: postEditing ? postEditing.author : (session.pubkey ?? undefined),
              })
            ).outcome
          : (await publishEventUpdate(ctx, base)).outcome;
      // R9: on a WSS-blocked queue the post is NOT visible to attendees yet, so
      // KEEP the durable draft (only editing a brand-new post has one) and report
      // honestly. Only a real relay publish retires the draft + resets the editor.
      if (outcome === "queued") {
        opStatus.queued(t("op.postQueued"));
      } else {
        resetEditor();
        // Published for real — the durable draft is no longer needed (U9).
        clearDraft(draftId);
        restoredDraft = false;
        opStatus.published(t("op.postPublished"));
      }
      await loadUpdates();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      postBusy = false;
    }
  }
</script>

<h2 class="section-head">{t("admin.section.communicate")}</h2>

<div class="card">
  <div class="field-label">{t("admin.posts.title")}</div>
  <p class="muted">
    {t("admin.posts.body")}
  </p>
  {#if restoredDraft && postEditing === null}
    <!-- Visible restore of an unsent draft (U9). -->
    <div class="row" style="justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap">
      <span class="muted" role="status">{t("draft.restored")}</span>
      <button class="btn inline" style="flex:none" onclick={discardDraft}>{t("draft.discard")}</button>
    </div>
  {/if}
  <PostEditor
    bind:title={postTitle}
    bind:summary={postSummary}
    bind:image={postImage}
    bind:content={postContent}
    bind:visibility={postVisibility}
    editing={postEditing !== null}
    busy={postBusy}
    onsubmit={publishPost}
    oncancel={resetEditor}
  />
  {#if posts.length}
    <div class="stack" style="margin-top:0.75rem">
      {#each posts as p (p.d)}
        <div class="row" style="justify-content:space-between">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            {p.locked ? t("post.locked.title") : p.title}
            {#if p.membersOnly}<span class="badge">{t("post.membersBadge")}</span>{/if}
            <span class="muted" style="font-size:0.75rem">
              · {new Date(p.publishedAt * 1000).toLocaleDateString()}
            </span>
          </span>
          {#if !p.locked}
            <button class="btn inline" style="flex:none" onclick={() => startEdit(p)}>
              {t("admin.posts.edit")}
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .section-head {
    margin-top: 1.5rem;
  }
</style>
