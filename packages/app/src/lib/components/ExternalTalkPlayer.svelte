<script lang="ts">
  // Plays a talk whose video lives OUTSIDE Blossom (user request 2026-07-24): an
  // unlisted YouTube link (privacy-friendly no-cookie embed, YouTube's own player
  // owns speed) or a direct mp4 URL (a plain <video> with the same speed control
  // as the encrypted player). The URL was decrypted from the ECK-encrypted talk
  // content, so this only renders for members.
  import type { TalkExternalKind } from "@nostrautica/protocol";
  import { youTubeId, youTubeEmbedUrl } from "$lib/media/external.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { url, kind }: { url: string; kind: TalkExternalKind } = $props();

  const embedUrl = $derived(kind === "youtube" ? ytEmbed(url) : null);
  function ytEmbed(u: string): string | null {
    const id = youTubeId(u);
    return id ? youTubeEmbedUrl(id) : null;
  }

  // Shared speed selector (matches MediaPlayer) for the direct-mp4 case only.
  const SPEEDS = [1, 1.5, 2] as const;
  const RATE_KEY = "nostrautica:playbackRate";
  let videoEl = $state<HTMLVideoElement | null>(null);
  function initialRate(): number {
    if (typeof localStorage === "undefined") return 1;
    const stored = Number(localStorage.getItem(RATE_KEY));
    return SPEEDS.includes(stored as (typeof SPEEDS)[number]) ? stored : 1;
  }
  let rate = $state(initialRate());
  function setRate(r: number) {
    rate = r;
    if (videoEl) videoEl.playbackRate = r;
    try {
      localStorage.setItem(RATE_KEY, String(r));
    } catch {
      /* storage disabled — in-memory rate still applies */
    }
  }
</script>

{#if kind === "youtube"}
  {#if embedUrl}
    <div class="yt-wrap">
      <iframe
        src={embedUrl}
        title={t("talks.external.videoTitle")}
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
        allowfullscreen
        referrerpolicy="strict-origin-when-cross-origin"
      ></iframe>
    </div>
  {:else}
    <a class="btn" href={url} target="_blank" rel="noopener noreferrer">{t("talks.external.open")}</a>
  {/if}
{:else}
  <!-- svelte-ignore a11y_media_has_caption -->
  <video
    bind:this={videoEl}
    src={url}
    controls
    playsinline
    style="max-width:100%;border-radius:12px"
    onloadedmetadata={() => videoEl && (videoEl.playbackRate = rate)}
  ></video>
  <div class="speed" role="group" aria-label={t("media.speed")}>
    <span class="speed-label">{t("media.speed")}</span>
    {#each SPEEDS as s (s)}
      <button
        class="btn inline speed-btn"
        aria-pressed={rate === s}
        class:primary={rate === s}
        onclick={() => setRate(s)}
      >
        {s}×
      </button>
    {/each}
  </div>
{/if}

<style>
  /* Responsive 16:9 embed that never overflows the card. */
  .yt-wrap {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    border-radius: 12px;
    overflow: hidden;
    background: #000;
  }
  .yt-wrap iframe {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
  }
  .speed {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    margin-top: 0.4rem;
    flex-wrap: wrap;
  }
  .speed-label {
    font-size: 0.8rem;
    color: var(--text-dim);
    margin-right: 0.15rem;
  }
  .speed-btn {
    min-height: 30px;
    padding: 0.2rem 0.5rem;
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
  }
</style>
