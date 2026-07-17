<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { MAX_INTRO_TEXT, UNLIMITED_SEC, type MediaDescriptor } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import { VideoCapture } from "$lib/media/capture.js";
  import {
    uploadMedia,
    submitProfileAndMedia,
    loadSelfCopy,
    loadLibrary,
    cachedLibrary,
    cachedSelfCopy,
    prepareReuse,
  } from "$lib/media/submit.js";
  import { submitTalk, newTalkId, takeTalkEditDraft } from "$lib/events/talks.js";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import { perfMark } from "$lib/perf.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { naddr, talk }: { naddr: string; talk: boolean } = $props();
  const kind = $derived<"intro" | "talk">(talk ? "talk" : "intro");
  const kindLabel = $derived(talk ? t("record.kind.talk") : t("record.kind.intro"));

  // Talk metadata (spec F2). A talk is submitted via a 21609 rumor (not the 21601
  // intro path) carrying title + description + the talk media. Editing an existing
  // talk reuses its `talk_d` and bumps the revision.
  let talkTitle = $state("");
  let talkDescription = $state("");
  let talkId = $state("");
  let talkRevision = $state(0);
  let editingTalk = $state(false);

  // Intro composer mode (spec F1.4). One recording engine (`VideoCapture`) serves
  // both video and audio; text bypasses capture/upload entirely. Feature 2 reuses
  // this same composer for talks via the `talk` prop.
  type Mode = "video" | "audio" | "text";
  let mode = $state<Mode>("video");

  // Cache-first (§2.7): the composer opens instantly with the last library/intro
  // from cache while the fresh copies refresh in the background.
  const cachedCtx = cachedEventContext(naddr);
  let ctx = $state<EventContext | null>(cachedCtx ?? null);
  let error = $state<unknown>(null);
  let videoEl = $state<HTMLVideoElement | null>(null);
  // Reactive so the UI reflects mic/camera-enabled state (hide the "Enable"
  // button once the stream is live — user feedback 2026-07-17).
  let stream = $state<MediaStream | null>(null);
  let capture: VideoCapture | null = null;

  let recording = $state(false);
  let remaining = $state(0);
  let recorded = $state<{ blob: Blob; url: string; durationSec: number } | null>(null);
  let busy = $state(false);
  let done = $state(false);
  let library = $state<MediaDescriptor[]>(cachedLibrary() ?? []);
  let textIntro = $state(
    cachedCtx ? (cachedSelfCopy(cachedCtx.coordinate)?.introText ?? "") : "",
  );

  // Live mic level (0..1) for the audio meter; driven by a Web Audio analyser.
  let micLevel = $state(0);
  let audioCtx: AudioContext | null = null;
  let meterRaf: number | null = null;

  // Pre-submit disclosure (H10): the intro must not leave the device until the
  // user acknowledges who processes it. Blocks every submit path below.
  let disclosureAck = $state(false);
  const hasCoordinator = $derived(!!ctx?.config.coordinator);

  const maxSec = $derived(ctx ? (talk ? ctx.config.maxTalkSec : ctx.config.maxVideoSec) : 90);
  // UNLIMITED_SEC (0) means the organizer set no length cap: no hard-stop, no countdown.
  const unlimited = $derived(maxSec === UNLIMITED_SEC);
  const textLeft = $derived(MAX_INTRO_TEXT - textIntro.length);

  if (cachedCtx && (library.length || textIntro)) perfMark("Record", "cache-paint");

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      // Editing an existing talk (handed off from TalkDetail): prefill + reuse id.
      if (talk) {
        const draft = takeTalkEditDraft();
        if (draft) {
          editingTalk = true;
          talkId = draft.talkId;
          talkTitle = draft.title;
          talkDescription = draft.description;
          talkRevision = draft.revision + 1;
        } else {
          talkId = newTalkId();
        }
      }
      if (session.signer) {
        const bk = await deriveBlindingKey(session.signer);
        library = await loadLibrary(session.signer, bk);
        const self = await loadSelfCopy(session.signer, ctx, bk);
        if (self?.introText) textIntro = self.introText;
      }
    } catch (e) {
      error = e;
    } finally {
      perfMark("Record", "network-settled");
    }
  });

  onDestroy(() => teardown());

  function stopMeter() {
    if (meterRaf !== null) cancelAnimationFrame(meterRaf);
    meterRaf = null;
    audioCtx?.close().catch(() => {});
    audioCtx = null;
    micLevel = 0;
  }

  function stopStream() {
    stopMeter();
    stream?.getTracks().forEach((tr) => tr.stop());
    stream = null;
  }

  function teardown() {
    stopStream();
    if (recorded) URL.revokeObjectURL(recorded.url);
  }

  /** Switch composer mode, tearing down any live capture/preview first. */
  function switchMode(m: Mode) {
    if (m === mode) return;
    capture?.stop();
    recording = false;
    stopStream();
    if (recorded) URL.revokeObjectURL(recorded.url);
    recorded = null;
    error = null;
    mode = m;
  }

  // Drive the mic meter off the live audio track (audio + video modes).
  function startMeter(src: MediaStream) {
    try {
      const AC = window.AudioContext ?? (window as any).webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      audioCtx.createMediaStreamSource(src).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        micLevel = Math.min(1, peak / 128);
        meterRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* meter is best-effort; recording still works without it */
    }
  }

  async function enableCamera() {
    error = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: true,
      });
      if (videoEl) {
        videoEl.srcObject = stream;
        videoEl.muted = true;
        await videoEl.play().catch(() => {});
      }
      startMeter(stream);
    } catch (e) {
      error = new Error(t("record.error.camera", { reason: (e as Error).message }));
    }
  }

  async function enableMic() {
    error = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      startMeter(stream);
    } catch (e) {
      error = new Error(t("record.error.mic", { reason: (e as Error).message }));
    }
  }

  async function startRecording() {
    if (!stream) await (mode === "audio" ? enableMic() : enableCamera());
    if (!stream) return;
    capture = new VideoCapture(mode === "audio" ? "audio" : "video");
    recording = true;
    // `remaining` is seconds-left for a capped event; for an unlimited event
    // capture.start() instead counts elapsed seconds up from 0 (no hard-stop).
    remaining = 0;
    try {
      const result = await capture.start(stream, maxSec, (r) => (remaining = r));
      recording = false;
      recorded = {
        blob: result.blob,
        url: URL.createObjectURL(result.blob),
        durationSec: result.durationSec,
      };
      stopMeter();
    } catch (e) {
      recording = false;
      error = e;
    }
  }

  function stopRecording() {
    capture?.stop();
  }

  function reRecord() {
    if (recorded) URL.revokeObjectURL(recorded.url);
    recorded = null;
  }

  /** File fallback (audit P2.8): use an existing clip instead of recording. */
  async function chooseFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    stopStream();
    const url = URL.createObjectURL(file);
    let durationSec = 0;
    try {
      durationSec = await readDuration(url, mode === "audio");
    } catch {
      /* duration is optional */
    }
    recorded = { blob: file, url, durationSec };
  }

  function readDuration(url: string, audio: boolean): Promise<number> {
    return new Promise((resolve, reject) => {
      const el = document.createElement(audio ? "audio" : "video");
      el.preload = "metadata";
      el.onloadedmetadata = () => resolve(Math.round(el.duration) || 0);
      el.onerror = () => reject(new Error("metadata"));
      el.src = url;
    });
  }

  async function submitRecorded() {
    if (!ctx || !session.signer || !recorded) return;
    busy = true;
    error = null;
    try {
      const descriptor = await uploadMedia(
        session.signer,
        ctx,
        recorded.blob,
        kind,
        recorded.durationSec,
      );
      await finishSubmitMedia(descriptor);
    } catch (e) {
      error = e;
    } finally {
      busy = false;
    }
  }

  async function submitText() {
    if (!ctx || !session.signer || !textIntro.trim()) return;
    busy = true;
    error = null;
    try {
      const signer = session.signer;
      const bk = await deriveBlindingKey(signer);
      const self = await loadSelfCopy(signer, ctx, bk);
      // A text intro replaces any recorded intro of this kind (drops its media).
      const media = (self?.media ?? []).filter((m) => m.kind !== kind);
      await submitProfileAndMedia(signer, ctx, {
        profile: self?.profile ?? { about: "", skills: [], looking_for: "", links: [] },
        media,
        blindingKey: bk,
        introText: textIntro.trim(),
      });
      finish();
    } catch (e) {
      error = e;
    } finally {
      busy = false;
    }
  }

  async function reuse(descriptor: MediaDescriptor, fresh: boolean) {
    if (!ctx || !session.signer) return;
    busy = true;
    error = null;
    try {
      const prepared = await prepareReuse(session.signer, ctx, descriptor, fresh);
      await finishSubmitMedia(prepared);
    } catch (e) {
      error = e;
    } finally {
      busy = false;
    }
  }

  async function finishSubmitMedia(descriptor: MediaDescriptor) {
    // A talk goes to the coordinator via a dedicated 21609 rumor (spec F2), NOT the
    // 21601 intro path — it carries title/description and is moderated separately.
    if (talk) {
      await submitTalk(session.signer!, ctx!, {
        talkId,
        title: talkTitle.trim(),
        description: talkDescription.trim(),
        media: descriptor,
        revision: talkRevision,
      });
      finish();
      return;
    }
    const signer = session.signer!;
    const bk = await deriveBlindingKey(signer);
    const self = await loadSelfCopy(signer, ctx!, bk);
    // Replace the existing intro of the same kind; keep other kinds (e.g. talks).
    // A recording supersedes any prior text intro (introText omitted below).
    const existingMedia = (self?.media ?? []).filter((m) => m.kind !== descriptor.kind);
    await submitProfileAndMedia(signer, ctx!, {
      profile: self?.profile ?? { about: "", skills: [], looking_for: "", links: [] },
      media: [...existingMedia, descriptor],
      blindingKey: bk,
    });
    finish();
  }

  function finish() {
    stopStream();
    done = true;
  }

  // Talks require a title (and always media — the text mode is intro-only).
  const canSubmit = $derived(disclosureAck && !busy && (!talk || talkTitle.trim().length > 0));
  const talksOff = $derived(talk && !!ctx && ctx.config.talks === "off");
</script>

<h1>{talk ? t("record.talk.title") : t("record.intro.title")}</h1>

{#if error}<ErrorState {error} />{/if}

{#if done}
  <div class="card" role="status">
    <p>{t("record.uploaded", { kind: kindLabel })}</p>
    <button class="btn primary" onclick={() => router.go({ name: "event", naddr })}>
      {t("record.backToEvent")}
    </button>
  </div>
{:else if !session.loggedIn}
  <div class="card">
    <button class="btn primary" onclick={() => router.go({ name: "login" })}>{t("record.loginFirst")}</button>
  </div>
{:else if talksOff}
  <!-- Deep-link guard: talks are off for this event, so there's no talk step. -->
  <div class="card" role="status">
    <p class="muted">{t("talks.disabled")}</p>
    <button class="btn primary" onclick={() => router.go({ name: "event", naddr })}>{t("record.backToEvent")}</button>
  </div>
{:else}
  {#if talk}
    <!-- Talk metadata (spec F2): title + description ride in the 21609 submission. -->
    <div class="card stack">
      {#if editingTalk}<p class="muted" style="margin:0">{t("talks.editing")}</p>{/if}
      <div>
        <label for="talk-title">{t("talks.field.title")}</label>
        <input id="talk-title" bind:value={talkTitle} maxlength="200" placeholder={t("talks.field.title.placeholder")} />
      </div>
      <div>
        <label for="talk-desc">{t("talks.field.description")}</label>
        <textarea id="talk-desc" rows="3" maxlength="2000" bind:value={talkDescription}></textarea>
      </div>
    </div>
  {/if}

  <!-- Mode tabs: video · audio · text (spec F1.4). Talks are media-only (no text). -->
  <div class="card">
    <div class="field-label" id="mode-label">{t("record.mode.label")}</div>
    <div class="row" role="tablist" aria-labelledby="mode-label" style="flex-wrap:wrap">
      <button class="btn inline" role="tab" aria-selected={mode === "video"} class:primary={mode === "video"} onclick={() => switchMode("video")}>{t("record.mode.video")}</button>
      <button class="btn inline" role="tab" aria-selected={mode === "audio"} class:primary={mode === "audio"} onclick={() => switchMode("audio")}>{t("record.mode.audio")}</button>
      {#if !talk}
        <button class="btn inline" role="tab" aria-selected={mode === "text"} class:primary={mode === "text"} onclick={() => switchMode("text")}>{t("record.mode.text")}</button>
      {/if}
    </div>
  </div>

  <!-- What is shared, and with whom, before anything leaves the device (H10).
       The text mode drops the audio/transcription bullet: nothing is recorded. -->
  <div class="card" style="background:var(--bg-elev2)">
    <strong>{t("record.disclosure.title")}</strong>
    <ul class="muted" style="margin:0.5rem 0;padding-left:1.1rem;line-height:1.5">
      <li>{t("record.disclosure.attendees")}</li>
      {#if hasCoordinator}
        <li>{t("record.disclosure.coordinator")}</li>
        <li>{mode === "text" ? t("record.disclosure.textProviders") : t("record.disclosure.providers")}</li>
      {/if}
    </ul>
    <label class="row" style="align-items:flex-start;gap:0.5rem;font-weight:400">
      <input
        type="checkbox"
        bind:checked={disclosureAck}
        style="width:auto;min-height:0;flex:none;margin-top:0.2rem"
      />
      <span>
        {#if !hasCoordinator}
          {t("record.disclosure.confirmNoCoord")}
        {:else if mode === "text"}
          {t("record.disclosure.confirmText")}
        {:else}
          {t("record.disclosure.confirm")}
        {/if}
      </span>
    </label>
  </div>

  {#if !talk && mode !== "text" && library.length > 0 && !recorded}
    <div class="card">
      <h2>{t("record.reuse.title")}</h2>
      <p class="muted">{t("record.reuse.body")}</p>
      {#each library as m (m.x)}
        <div class="row" style="justify-content:space-between;margin-top:0.5rem">
          <span class="badge">{m.kind === "talk" ? t("record.kind.talk") : t("record.kind.intro")} · {m.duration ?? "?"}s</span>
          <div class="row">
            <button class="btn inline" onclick={() => reuse(m, false)} disabled={!canSubmit}>{t("record.reuse.reuse")}</button>
            <button class="btn inline" onclick={() => reuse(m, true)} disabled={!canSubmit}>{t("record.reuse.fresh")}</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if mode === "text"}
    <div class="card">
      <h2>{t("record.text.title")}</h2>
      <p class="muted">{t("record.text.hint")}</p>
      <textarea
        rows="6"
        maxlength={MAX_INTRO_TEXT}
        placeholder={t("record.text.placeholder")}
        bind:value={textIntro}
        aria-label={t("record.text.title")}
      ></textarea>
      <p class="muted" style="text-align:right;font-size:0.8rem" aria-live="polite">
        {t("record.text.count", { n: textIntro.length, max: MAX_INTRO_TEXT })}
      </p>
      <button
        class="btn primary"
        onclick={submitText}
        disabled={!canSubmit || !textIntro.trim() || textLeft < 0}
      >
        {busy ? t("record.uploading") : t("record.text.submit")}
      </button>
    </div>
  {:else}
    <div class="card">
      {#if recorded}
        {#if mode === "audio"}
          <audio src={recorded.url} controls style="width:100%"></audio>
        {:else}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video src={recorded.url} controls playsinline style="max-width:100%;border-radius:12px"></video>
        {/if}
        <p class="muted">{t("record.recorded", { sec: recorded.durationSec })}</p>
        <div class="row">
          <button class="btn" onclick={reRecord} disabled={busy}>{t("record.reRecord")}</button>
          <button class="btn primary" onclick={submitRecorded} disabled={!canSubmit}>
            {busy ? t("record.uploading") : t("record.useThis")}
          </button>
        </div>
      {:else}
        {#if mode === "audio"}
          <p class="muted">{t("record.audio.hint")}</p>
          <!-- Live mic meter (audit P2.8): shows the microphone is working. -->
          <div
            class="meter"
            role="meter"
            aria-label={t("record.micLevel")}
            aria-valuenow={Math.round(micLevel * 100)}
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div class="meter-fill" style="width:{Math.round(micLevel * 100)}%"></div>
          </div>
        {:else}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video bind:this={videoEl} playsinline muted style="max-width:100%;border-radius:12px;background:#000"></video>
        {/if}
        <p class="muted" role="status" aria-live="polite">
          {unlimited ? t("record.limit.unlimited") : t("record.limit", { sec: maxSec })}
          {#if recording}
            <strong>{unlimited ? t("record.elapsed", { sec: remaining }) : t("record.timeLeft", { sec: remaining })}</strong>
          {/if}
        </p>
        {#if recording}
          <button class="btn danger" onclick={stopRecording}>{t("record.stop")}</button>
        {:else}
          <div class="row" style="flex-wrap:wrap">
            {#if stream}
              <!-- Device already granted → confirm it's ready instead of asking again. -->
              <span class="badge ok">{mode === "audio" ? t("record.micReady") : t("record.camReady")}</span>
            {:else if mode === "audio"}
              <button class="btn" onclick={enableMic}>{t("record.audio.enableMic")}</button>
            {:else}
              <button class="btn" onclick={enableCamera}>{t("record.enableCamera")}</button>
            {/if}
            {#if mode === "audio"}
              <button class="btn primary" onclick={startRecording}>{t("record.audio.record")}</button>
            {:else}
              <button class="btn primary" onclick={startRecording}>{t("record.record")}</button>
            {/if}
            <label class="btn" style="cursor:pointer">
              {t("record.chooseFile")}
              <input
                type="file"
                accept={mode === "audio" ? "audio/*" : "video/*"}
                onchange={chooseFile}
                style="display:none"
              />
            </label>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
{/if}

<style>
  .meter {
    height: 10px;
    border-radius: 6px;
    background: var(--bg-elev2);
    overflow: hidden;
    margin: 0.5rem 0;
  }
  .meter-fill {
    height: 100%;
    background: var(--accent);
    transition: width 80ms linear;
  }
</style>
