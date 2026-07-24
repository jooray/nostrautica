<script lang="ts">
  // Plays a talk whose video lives OUTSIDE Blossom (user request 2026-07-24): an
  // unlisted YouTube link (privacy-friendly no-cookie embed, YouTube's own player
  // owns speed) or a direct mp4 URL (a plain <video> with the same speed control
  // as the encrypted player). The URL was decrypted from the ECK-encrypted talk
  // content, so this only renders for members.
  import type { TalkExternalKind } from "@nostrautica/protocol";
  import {
    youTubeId,
    youTubeEmbedUrl,
    talkUrlHost,
    externalReferrerPolicy,
  } from "$lib/media/external.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { url, kind }: { url: string; kind: TalkExternalKind } = $props();

  const embedUrl = $derived(kind === "youtube" ? ytEmbed(url) : null);
  function ytEmbed(u: string): string | null {
    const id = youTubeId(u);
    return id ? youTubeEmbedUrl(id) : null;
  }

  // Third-party load gate (audit U10): nothing off-origin loads until the viewer
  // makes an explicit gesture. Opening a talk otherwise silently discloses IP /
  // timing / referrer to a speaker-controlled host (YouTube embed OR a direct
  // <video src>) — which could be a tracking endpoint, not a video. We show the
  // host and a plain-language note that playback contacts it, then load on click.
  //
  // Referrer policy is per-source (see below): the direct <video> sends NO
  // referrer, but the YouTube iframe MUST send its origin — YouTube's embedded
  // player refuses to play with a stripped referrer and returns Error 153 ("Video
  // player configuration error"). `referrerpolicy="origin"` sends only the scheme
  // + host (never the full hash-routed URL), so it stays privacy-preserving while
  // satisfying the embed's referrer check.
  const host = $derived(talkUrlHost(url));
  let loaded = $state(false);

  // Set referrerPolicy BEFORE assigning src so the very first media request to the
  // external host carries no referrer (audit U10). Doing this in markup isn't
  // possible — `referrerpolicy` isn't typed on <video> — and setting it after a
  // declarative `src` would be too late (the fetch already started).
  function directVideo(node: HTMLVideoElement, u: string) {
    // `referrerPolicy` isn't in the DOM typing for media elements, but the
    // attribute is honored by browsers — set it before src so it applies.
    node.setAttribute("referrerpolicy", externalReferrerPolicy("video"));
    node.src = u;
    return {
      update(next: string) {
        node.src = next;
      },
    };
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

{#if !loaded}
  <!-- Pre-load privacy gate (audit U10): no off-origin request until this click. -->
  <div class="load-gate">
    <p class="gate-title">{t("talks.external.gate.title")}</p>
    <p class="gate-host">
      {t("talks.external.gate.host")}
      <strong>{host ?? url}</strong>
    </p>
    <p class="gate-note muted">{t("talks.external.gate.note")}</p>
    <div class="row" style="flex-wrap:wrap">
      <button class="btn primary" onclick={() => (loaded = true)}>{t("talks.external.gate.load")}</button>
      <a class="btn" href={url} target="_blank" rel="noopener noreferrer nofollow">{t("talks.external.open")}</a>
    </div>
  </div>
{:else if kind === "youtube"}
  {#if embedUrl}
    <div class="yt-wrap">
      <iframe
        src={embedUrl}
        title={t("talks.external.videoTitle")}
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
        allowfullscreen
        referrerpolicy={externalReferrerPolicy("youtube")}
      ></iframe>
    </div>
  {:else}
    <a class="btn" href={url} target="_blank" rel="noopener noreferrer nofollow">{t("talks.external.open")}</a>
  {/if}
{:else}
  <!-- svelte-ignore a11y_media_has_caption -->
  <video
    bind:this={videoEl}
    use:directVideo={url}
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
  .load-gate {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1rem;
    background: var(--bg-elev2);
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .gate-title {
    margin: 0;
    font-weight: 650;
  }
  .gate-host {
    margin: 0;
    font-size: 0.9rem;
    word-break: break-all;
  }
  .gate-note {
    margin: 0 0 0.4rem;
    font-size: 0.85rem;
  }
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
