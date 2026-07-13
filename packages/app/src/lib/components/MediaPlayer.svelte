<script lang="ts">
  import { onDestroy } from "svelte";
  import type { MediaDescriptor } from "@nostrautica/protocol";
  import { resolveMediaUrl, releaseMediaUrl } from "$lib/media/playback.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { descriptor }: { descriptor: MediaDescriptor } = $props();

  let url = $state<string | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);

  async function load() {
    loading = true;
    error = null;
    try {
      url = await resolveMediaUrl(descriptor);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onDestroy(() => {
    if (url) releaseMediaUrl(descriptor);
  });
</script>

{#if url}
  <!-- svelte-ignore a11y_media_has_caption -->
  <video src={url} controls playsinline style="max-width:100%;border-radius:12px"></video>
{:else if error}
  <div class="card warn">{t("media.playError", { reason: error })}</div>
{:else}
  <button class="btn" onclick={load} disabled={loading}>
    {loading ? t("media.decrypting") : t("media.playIntro")}
  </button>
{/if}
