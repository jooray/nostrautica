<script lang="ts">
  import { onDestroy } from "svelte";
  import type { MediaDescriptor, MediaTranscript } from "@nostrautica/protocol";
  import { resolveMediaUrl, releaseMediaUrl } from "$lib/media/playback.js";
  import type { DownloadProgress } from "$lib/blossom/client.js";
  import { vttObjectUrl } from "$lib/media/vtt.js";
  import { formatBytes } from "$lib/util/bytes.js";
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
  let progress = $state<DownloadProgress | null>(null);
  let showTranscript = $state(false);
  let mediaEl = $state<HTMLMediaElement | null>(null);
  let lastReport = 0;

  // Playback speed (user request 2026-07-24): watch a long talk or intro at 2×.
  // The choice persists across players/sessions — someone who prefers 1.5× keeps
  // it — and is re-applied on every load() since a fresh media element resets to
  // 1.0. Native <video>/<audio> controls expose speed inconsistently (absent on
  // most mobile browsers), so we surface an explicit selector.
  const SPEEDS = [1, 1.5, 2] as const;
  const RATE_KEY = "nostrautica:playbackRate";
  function initialRate(): number {
    if (typeof localStorage === "undefined") return 1;
    const stored = Number(localStorage.getItem(RATE_KEY));
    return SPEEDS.includes(stored as (typeof SPEEDS)[number]) ? stored : 1;
  }
  let rate = $state(initialRate());
  function setRate(r: number) {
    rate = r;
    if (mediaEl) mediaEl.playbackRate = r;
    try {
      localStorage.setItem(RATE_KEY, String(r));
    } catch {
      /* private mode / storage disabled — the in-memory rate still applies */
    }
  }
  /** "1×", "1.5×", "2×" — trim the trailing ".0" so 1× and 2× read cleanly. */
  function rateLabel(r: number): string {
    return `${r}×`;
  }

  function onLoadedMeta() {
    // A new media element always starts at 1.0 — restore the chosen rate.
    if (mediaEl) mediaEl.playbackRate = rate;
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

  // Audio intros (spec F1) play through <audio>; video through <video>.
  const isAudio = $derived(descriptor.m.startsWith("audio/"));

  // Captions track (audit §7.3.6). The transcript wire format carries plain text
  // only (no per-segment timing), so we synthesize a single whole-duration cue —
  // a real, browser-native `<track kind="captions">` the caption UI + screen
  // readers surface, not merely the offscreen transcript block below. A properly
  // time-aligned track needs segment timing the schema does not yet carry.
  let captionsUrl = $state<string | null>(null);
  $effect(() => {
    // Rebuild whenever the transcript text changes; revoke the prior blob URL.
    const text = transcript?.text?.trim();
    if (!text) {
      captionsUrl = null;
      return;
    }
    const u = vttObjectUrl(text);
    captionsUrl = u;
    return () => URL.revokeObjectURL(u);
  });

  // Loading is two phases the user experiences very differently: a download whose
  // length is set by their connection (a talk video on hotel wifi is minutes, and
  // used to look identical to a broken server), then a decrypt with nothing to
  // report. `progress` covers the first; reaching `total` marks the handover.
  const pct = $derived(
    progress?.total ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : null,
  );
  // Rounding, not `pct === 100`: 99.6% rounds to 100 and would claim "Decrypting"
  // while bytes are still arriving.
  const downloaded = $derived(!!progress?.total && progress.received >= progress.total);
  const stage = $derived(
    progress === null
      ? t("media.connecting") // no response headers yet — nothing to count
      : downloaded
        ? t("media.decrypting")
        : progress.total
          ? t("media.downloadingOf", {
              done: formatBytes(progress.received),
              total: formatBytes(progress.total),
            })
          : t("media.downloading", { done: formatBytes(progress.received) }),
  );

  async function load() {
    loading = true;
    error = null;
    progress = null;
    try {
      url = await resolveMediaUrl(descriptor, { onProgress: (p) => (progress = p) });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
      progress = null;
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
    <!-- Captions come from an optional transcript track, rendered below only when a
         transcript exists; user-recorded talk/intro clips frequently have none, so a
         caption track is not always available for this player. -->
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={mediaEl}
      src={url}
      controls
      playsinline
      style="max-width:100%;border-radius:12px"
      onloadedmetadata={onLoadedMeta}
      ontimeupdate={onTimeUpdate}
    >
      {#if captionsUrl}
        <track
          kind="captions"
          src={captionsUrl}
          srclang={transcript?.lang}
          label={t("media.captionsLabel")}
          default
        />
      {/if}
    </video>
  {/if}
  <div class="speed" role="group" aria-label={t("media.speed")}>
    <span class="speed-label">{t("media.speed")}</span>
    {#each SPEEDS as s (s)}
      <button
        class="btn inline speed-btn"
        aria-pressed={rate === s}
        class:primary={rate === s}
        onclick={() => setRate(s)}
      >
        {rateLabel(s)}
      </button>
    {/each}
  </div>
{:else if loading}
  <!-- A progressbar, not a live region: `stage` changes on every chunk, and a
       polite live region would read the byte counter aloud dozens of times. The
       visible text says the same thing as aria-valuetext, so it's hidden from
       assistive tech rather than announced twice. -->
  <div class="loading">
    <div
      class="track"
      role="progressbar"
      aria-label={t("media.loading")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      aria-valuetext={stage}
    >
      <div
        class="fill"
        class:indeterminate={pct === null}
        style={pct === null ? "" : `width:${pct}%`}
      ></div>
    </div>
    <span class="stage" aria-hidden="true">{stage}</span>
  </div>
{:else if error}
  <div class="card warn">{t("media.playError", { reason: error })}</div>
{:else}
  <button class="btn" onclick={load}>
    {isAudio ? t("media.playAudio") : t("media.playIntro")}
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
  .loading {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    /* Same box the Play button occupied, so the card doesn't jump on click. */
    padding: 0.35rem 0;
  }
  .track {
    height: 6px;
    border-radius: 3px;
    background: var(--bg-elev2);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    width: 0;
    border-radius: 3px;
    background: var(--accent-bg);
    transition: width 0.2s linear;
  }
  /* Before the first byte lands there is no percentage to show — sweep instead
     of sitting at 0%, which reads as "stuck". */
  .fill.indeterminate {
    width: 35%;
    animation: sweep 1.4s ease-in-out infinite;
  }
  @keyframes sweep {
    0% {
      margin-left: -35%;
    }
    100% {
      margin-left: 100%;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fill {
      transition: none;
    }
    .fill.indeterminate {
      animation: none;
      width: 100%;
      opacity: 0.4;
    }
  }
  .stage {
    font-size: 0.8rem;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
</style>
