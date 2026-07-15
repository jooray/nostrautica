<script lang="ts">
  import { onDestroy } from "svelte";
  import type { MediaDescriptor, MediaTranscript } from "@nostrautica/protocol";
  import { resolveMediaUrl, releaseMediaUrl } from "$lib/media/playback.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let {
    descriptor,
    transcript,
    // Watch-progress hooks (spec F2.4). Optional: intros pass neither. `resumeAt`
    // seeks the media there once it loads; `onProgress` reports the play position.
    resumeAt = 0,
    onProgress,
  }: {
    descriptor: MediaDescriptor;
    transcript?: MediaTranscript;
    resumeAt?: number;
    onProgress?: (seconds: number) => void;
  } = $props();

  let url = $state<string | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let showTranscript = $state(false);
  let mediaEl = $state<HTMLMediaElement | null>(null);
  let lastReport = 0;

  function onLoadedMeta() {
    if (resumeAt > 0 && mediaEl && resumeAt < mediaEl.duration - 1) {
      mediaEl.currentTime = resumeAt;
    }
  }
  function onTimeUpdate() {
    if (!onProgress || !mediaEl) return;
    const now = mediaEl.currentTime;
    // Throttle to ~once every 5s of playback so we don't thrash storage.
    if (Math.abs(now - lastReport) >= 5) {
      lastReport = now;
      onProgress(now);
    }
  }

  // Audio intros (spec F1) play through <audio>; video through <video>. There are
  // no timed caption tracks yet (VTT is a phase-2 follow-up), so the published
  // transcript below is the nonvisual consumption path (audit A1).
  const isAudio = $derived(descriptor.m.startsWith("audio/"));

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
  {#if isAudio}
    <audio
      bind:this={mediaEl}
      src={url}
      controls
      style="width:100%"
      onloadedmetadata={onLoadedMeta}
      ontimeupdate={onTimeUpdate}
    ></audio>
  {:else}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={mediaEl}
      src={url}
      controls
      playsinline
      style="max-width:100%;border-radius:12px"
      onloadedmetadata={onLoadedMeta}
      ontimeupdate={onTimeUpdate}
    ></video>
  {/if}
{:else if error}
  <div class="card warn">{t("media.playError", { reason: error })}</div>
{:else}
  <button class="btn" onclick={load} disabled={loading}>
    {loading ? t("media.decrypting") : isAudio ? t("media.playAudio") : t("media.playIntro")}
  </button>
{/if}

<!-- Nonvisual consumption path (audit A1): a real, screen-reader-readable
     transcript. Truthful status when none is available — no suppressed warnings. -->
<div class="transcript" style="margin-top:0.4rem">
  {#if transcript?.text}
    <button
      class="linklike"
      aria-expanded={showTranscript}
      onclick={() => (showTranscript = !showTranscript)}
    >
      {showTranscript ? t("media.hideTranscript") : t("media.showTranscript")}
    </button>
    {#if showTranscript}
      <div class="card" style="background:var(--bg-elev2);margin-top:0.4rem">
        {#if transcript.source === "stt"}
          <p class="muted" style="margin:0 0 0.35rem;font-size:0.8rem">{t("media.transcript.machine")}</p>
        {/if}
        <p style="margin:0;white-space:pre-wrap" lang={transcript.lang}>{transcript.text}</p>
      </div>
    {/if}
  {:else}
    <span class="muted" style="font-size:0.8rem">{t("media.captionsUnavailable")}</span>
  {/if}
</div>

<style>
  .linklike {
    width: auto;
    min-height: 0;
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    text-decoration: underline;
  }
</style>
