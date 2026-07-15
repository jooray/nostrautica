<script lang="ts">
  /**
   * Post composer (spec §7.4 / §8 "Publish event post"): title/summary/image +
   * markdown with a preview tab and a byte counter. Visibility is chosen at
   * creation ONLY — the radio is locked when editing an existing post. The
   * 60,000-byte members-only markdown cap is enforced here with a readable
   * error (NIP-44 single-payload ceiling; chunking is out of scope for v1).
   */
  import { renderMarkdown } from "$lib/social/markdown.js";
  import {
    utf8ByteLength,
    MAX_MEMBERS_POST_MARKDOWN_BYTES,
  } from "@nostrautica/protocol";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import type { PostVisibility } from "$lib/events/posts.js";

  let {
    title = $bindable(""),
    summary = $bindable(""),
    image = $bindable(""),
    content = $bindable(""),
    visibility = $bindable<PostVisibility>("public"),
    editing = false,
    canMembers = true,
    busy = false,
    onsubmit,
    oncancel,
  }: {
    title?: string;
    summary?: string;
    image?: string;
    content?: string;
    visibility?: PostVisibility;
    /** Editing an existing post: `d` and visibility are fixed (spec §7.4). */
    editing?: boolean;
    /** Whether members-only is offered (requires an ECK; organizers have one). */
    canMembers?: boolean;
    busy?: boolean;
    onsubmit: () => void;
    oncancel?: () => void;
  } = $props();

  let tab = $state<"write" | "preview">("write");

  const bytes = $derived(utf8ByteLength(content));
  const overCap = $derived(
    visibility === "members" && bytes > MAX_MEMBERS_POST_MARKDOWN_BYTES,
  );
  const canSubmit = $derived(
    !busy && !overCap && title.trim().length > 0 && content.trim().length > 0,
  );
</script>

<div class="stack">
  <input placeholder={t("post.editor.titlePlaceholder")} bind:value={title} />
  <input placeholder={t("post.editor.summaryPlaceholder")} bind:value={summary} />
  <input placeholder={t("post.editor.imagePlaceholder")} bind:value={image} />

  <fieldset class="visibility" disabled={editing || !canMembers}>
    <legend class="field-label">{t("post.editor.visibility")}</legend>
    <label class="radio">
      <input type="radio" value="public" bind:group={visibility} />
      <span>
        {t("post.editor.public")}
        <span class="muted">— {t("post.editor.public.hint")}</span>
      </span>
    </label>
    <label class="radio">
      <input type="radio" value="members" bind:group={visibility} />
      <span>
        {t("post.editor.members")}
        <span class="muted">— {t("post.editor.members.hint")}</span>
      </span>
    </label>
    {#if editing}
      <p class="muted" style="margin:0.25rem 0 0">{t("post.editor.visibilityLocked")}</p>
    {/if}
  </fieldset>

  <div class="row tabs">
    <button
      type="button"
      class="btn inline"
      class:primary={tab === "write"}
      onclick={() => (tab = "write")}
    >
      {t("post.editor.write")}
    </button>
    <button
      type="button"
      class="btn inline"
      class:primary={tab === "preview"}
      onclick={() => (tab = "preview")}
    >
      {t("post.editor.preview")}
    </button>
    <span class="muted counter" class:over={overCap}>
      {#if visibility === "members"}
        {t("post.editor.byteCount", { used: bytes, max: MAX_MEMBERS_POST_MARKDOWN_BYTES })}
      {:else}
        {t("post.editor.bytes", { n: bytes })}
      {/if}
    </span>
  </div>

  {#if tab === "write"}
    <textarea rows="8" placeholder={t("post.editor.contentPlaceholder")} bind:value={content}
    ></textarea>
  {:else}
    <div class="card preview longform">
      {#if content.trim()}
        <!-- Safe: renderMarkdown escapes the source before emitting its own tags. -->
        {@html renderMarkdown(content)}
      {:else}
        <p class="muted" style="margin:0">{t("post.editor.nothingToPreview")}</p>
      {/if}
    </div>
  {/if}

  {#if overCap}
    <p class="over" style="margin:0">
      {t("post.editor.tooLong", {
        max: MAX_MEMBERS_POST_MARKDOWN_BYTES,
        over: bytes - MAX_MEMBERS_POST_MARKDOWN_BYTES,
      })}
    </p>
  {/if}

  <div class="row">
    <button class="btn inline primary" onclick={onsubmit} disabled={!canSubmit}>
      {busy
        ? t("post.editor.publishing")
        : editing
          ? t("post.editor.saveEdit")
          : t("post.editor.publish")}
    </button>
    {#if editing && oncancel}
      <button class="btn inline" onclick={oncancel}>{t("post.editor.cancelEdit")}</button>
    {/if}
  </div>
</div>

<style>
  .visibility {
    border: none;
    margin: 0;
    padding: 0;
  }
  .radio {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin: 0.25rem 0;
  }
  .radio input {
    width: auto;
  }
  .tabs {
    align-items: center;
  }
  .counter {
    margin-left: auto;
    font-size: 0.75rem;
  }
  .over {
    color: var(--danger);
  }
  .preview :global(p) {
    margin: 0.5rem 0;
  }
  .preview :global(img) {
    max-width: 100%;
  }
  .preview :global(.md-table) {
    overflow-x: auto;
  }
</style>
