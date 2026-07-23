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
  import { session } from "$lib/signer/session.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { uploadPublicImage } from "$lib/media/image.js";
  import Icon from "$lib/components/icons/Icon.svelte";
  import FileButton from "$lib/components/FileButton.svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import type { PostVisibility } from "$lib/events/posts.js";
  import { refreshGuard } from "$lib/stores/refresh-guard.svelte.js";

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
  let uploading = $state(false);
  let uploadError = $state("");

  // Draft-safe auto-refresh (App-2): hold the pending reload while a post is
  // being composed, so an automatic deploy doesn't wipe an unsaved draft; it
  // applies once the editor is submitted, cancelled, or emptied.
  $effect(() => {
    if (title.trim().length > 0 || content.trim().length > 0) return refreshGuard.hold("post");
  });

  async function onImageFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file || !session.signer) return;
    uploading = true;
    uploadError = "";
    try {
      await connectNdk();
      image = await uploadPublicImage(session.signer, file);
    } catch (err) {
      uploadError = err instanceof Error ? err.message : String(err);
    } finally {
      uploading = false;
    }
  }

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

  <div class="image-field">
    <input placeholder={t("post.editor.imagePlaceholder")} bind:value={image} />
    <FileButton
      class="btn inline upload"
      accept="image/*"
      onchange={onImageFile}
      disabled={uploading}
      label={t("post.editor.upload")}
    >
      <Icon name="plus" size={15} />
      {uploading ? t("post.editor.uploading") : t("post.editor.upload")}
    </FileButton>
  </div>
  {#if image}
    <img class="image-preview" src={image} alt={t("post.editor.imagePreview")} />
  {/if}
  {#if uploadError}<p class="over" style="margin:0">{uploadError}</p>{/if}

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
    align-items: flex-start;
    gap: 0.6rem;
    margin: 0.5rem 0;
    cursor: pointer;
  }
  /* The global `input` rule styles every input as a 44px-tall field; reset the
     radio to a real custom control so it doesn't blow the row layout apart. */
  .radio input[type="radio"] {
    appearance: none;
    -webkit-appearance: none;
    flex: none;
    width: 18px;
    height: 18px;
    min-height: 0;
    margin: 1px 0 0;
    padding: 0;
    border: 2px solid var(--border);
    border-radius: 50%;
    background: var(--bg);
    display: grid;
    place-content: center;
    cursor: pointer;
    transition: border-color 0.15s ease;
  }
  .radio input[type="radio"]::before {
    content: "";
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--accent-bg);
    transform: scale(0);
    transition: transform 0.12s ease;
  }
  .radio input[type="radio"]:checked {
    border-color: var(--accent-bg);
  }
  .radio input[type="radio"]:checked::before {
    transform: scale(1);
  }
  .radio input[type="radio"]:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .visibility[disabled] {
    opacity: 0.6;
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
  .image-field {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .image-field > input {
    flex: 1;
    min-width: 0;
  }
  .upload {
    width: auto;
    flex: none;
    white-space: nowrap;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .image-preview {
    max-width: 100%;
    max-height: 160px;
    border-radius: var(--radius-sm, 8px);
    object-fit: cover;
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
