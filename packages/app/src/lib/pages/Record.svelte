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
    loadLibraryFull,
    cachedLibrary,
    cachedTextLibrary,
    cachedSelfCopy,
    prepareReuse,
  } from "$lib/media/submit.js";
  import { submitTalk, newTalkId, takeTalkEditDraft } from "$lib/events/talks.js";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import ErrorSummary from "$lib/components/ErrorSummary.svelte";
  import { validate, hasError, describedBy, type FieldError } from "$lib/stores/form-validation.js";
  import MediaPlayer from "$lib/components/MediaPlayer.svelte";
  import FileButton from "$lib/components/FileButton.svelte";
  import { perfMark } from "$lib/perf.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import { refreshGuard } from "$lib/stores/refresh-guard.svelte.js";
  import { opStatus } from "$lib/stores/op-status.svelte.js";
  import { online } from "$lib/stores/online.svelte.js";
  import { classifyDeviceError, deviceErrorMessageKey } from "$lib/media/device-error.js";
  import type { MessageKey } from "$lib/i18n/messages.js";

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
  // Cross-event reuse library (spec §6.2): recorded intros + authored text intros
  // the user made at ANY previous event, offered here so they needn't redo one.
  let library = $state<MediaDescriptor[]>(cachedLibrary() ?? []);
  let textLibrary = $state<string[]>(cachedTextLibrary() ?? []);
  // Only intros are reusable AS an intro (a stored talk clip isn't an intro).
  const introLibrary = $derived(library.filter((m) => m.kind === "intro"));
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

  if (cachedCtx && (library.length || textLibrary.length || textIntro)) perfMark("Record", "cache-paint");

  // Draft-safe auto-refresh (App-2): an automatic deploy reload must never
  // interrupt a live recording or discard an unsaved intro/talk the user is
  // typing. Hold the pending reload while any of that is in flight; it applies
  // automatically once recording stops and the fields are clear/submitted. (The
  // intro text itself is already round-tripped through `cachedSelfCopy`, so no
  // extra draft store is needed here — this only gates the reload.)
  $effect(() => {
    const dirty =
      recording ||
      textIntro.trim().length > 0 ||
      talkTitle.trim().length > 0 ||
      talkDescription.trim().length > 0;
    if (dirty) return refreshGuard.hold("record");
  });

  // Clear any prior operation status once the user edits again (audit §7.3.9:
  // next-edit lifetime). No-ops until a status has actually been set.
  $effect(() => {
    void textIntro;
    void talkTitle;
    void talkDescription;
    opStatus.clearOnEdit();
  });

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
        const lib = await loadLibraryFull(session.signer, bk);
        library = lib.media;
        textLibrary = lib.texts;
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
    // Stop the recorder too, not just the tracks (audit App-4): if the component
    // is destroyed mid-recording, stopStream() ends the hardware tracks but the
    // MediaRecorder itself stays un-stopped, leaking the capture object.
    capture?.stop();
    recording = false;
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
      if (!navigator.mediaDevices?.getUserMedia) throw new TypeError("no mediaDevices");
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
      // Distinct recovery per cause (§7.4.10): denied / absent / busy / unsupported.
      error = new Error(t(deviceErrorMessageKey(classifyDeviceError(e), false) as MessageKey));
    }
  }

  async function enableMic() {
    error = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new TypeError("no mediaDevices");
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      startMeter(stream);
    } catch (e) {
      error = new Error(t(deviceErrorMessageKey(classifyDeviceError(e), true) as MessageKey));
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
    // Replacing a prior selection/recording: revoke its object URL first so
    // picking a different file doesn't orphan the previous one (audit App-4).
    if (recorded) URL.revokeObjectURL(recorded.url);
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
    if (!checkSubmit(false)) return;
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
    if (!ctx || !session.signer) return;
    if (!checkSubmit(true)) return;
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

  /**
   * Reuse a previous TEXT intro. There's no blob to re-key (the "fresh copy"
   * distinction is media-only), so we load the chosen text into the composer and
   * switch to text mode: the user can submit it as-is or tweak it first, then the
   * normal text-submit path runs.
   */
  function useTextFromLibrary(text: string) {
    textIntro = text;
    switchMode("text");
  }

  async function reuse(descriptor: MediaDescriptor, fresh: boolean) {
    if (!ctx || !session.signer) return;
    if (!checkSubmit(false)) return;
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
    // Announce the outcome in the shared live region (audit §7.3.9). Offline →
    // the durable outbox holds it; a talk is coordinator-moderated; an intro is
    // published to relays. Truthful about what actually happened.
    if (!online.isOnline) opStatus.queued(t("op.queued", { what: kindLabel }));
    else if (talk) opStatus.acknowledged(t("op.talkSubmitted"));
    else opStatus.published(t("op.introPublished"));
  }

  const talksOff = $derived(talk && !!ctx && ctx.config.talks === "off");

  // Submit gating via the shared error-summary validation pattern (§7.3.7),
  // replacing the old disabled-button gate: on a submit attempt the offending
  // fields are listed in a focusable summary and linked to their inputs, instead
  // of silently disabling the button with no explanation of what's missing.
  // Checks are in DOM order (talk title, disclosure ack, then the text intro).
  let showErrors = $state(false);
  let fieldErrors = $state<FieldError[]>([]);
  function checkSubmit(needText: boolean): boolean {
    const result = validate([
      { id: "talk-title", message: talk && !talkTitle.trim() ? t("record.error.talkTitle") : null },
      { id: "disclosure-ack", message: !disclosureAck ? t("record.error.disclosure") : null },
      {
        id: "record-text",
        message: needText && !textIntro.trim() ? t("record.error.textRequired") : null,
      },
    ]);
    fieldErrors = result.errors;
    showErrors = !result.ok;
    if (!result.ok && result.firstErrorId) document.getElementById(result.firstErrorId)?.focus();
    return result.ok;
  }
  const errTalkTitle = $derived(showErrors && hasError(fieldErrors, "talk-title"));
  const errDisclosure = $derived(showErrors && hasError(fieldErrors, "disclosure-ack"));
  const errText = $derived(showErrors && hasError(fieldErrors, "record-text"));
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
  {#if showErrors}<ErrorSummary errors={fieldErrors} />{/if}

  {#if talk}
    <!-- Talk metadata (spec F2): title + description ride in the 21609 submission. -->
    <div class="card stack">
      {#if editingTalk}<p class="muted" style="margin:0">{t("talks.editing")}</p>{/if}
      <div>
        <label for="talk-title">{t("talks.field.title")}</label>
        <input
          id="talk-title"
          bind:value={talkTitle}
          maxlength="200"
          placeholder={t("talks.field.title.placeholder")}
          aria-invalid={errTalkTitle}
          aria-describedby={describedBy("talk-title", errTalkTitle)}
        />
        {#if errTalkTitle}<p id="talk-title-error" class="field-error">{t("record.error.talkTitle")}</p>{/if}
      </div>
      <div>
        <label for="talk-desc">{t("talks.field.description")}</label>
        <textarea id="talk-desc" rows="3" maxlength="2000" bind:value={talkDescription}></textarea>
      </div>
    </div>
  {/if}

  <!-- Mode switcher: video · audio · text (spec F1.4). Talks are media-only (no
       text). Plain pressed buttons (audit §7.3.3), NOT an ARIA tabs widget: the
       three panels below are ordinary page content (not focus-managed tabpanels),
       so `aria-pressed` toggle buttons in a labelled group is the honest, fully
       implemented pattern — no half-built roving-focus tablist. -->
  <div class="card">
    <div class="field-label" id="mode-label">{t("record.mode.label")}</div>
    <div class="row" role="group" aria-labelledby="mode-label" style="flex-wrap:wrap">
      <button type="button" class="btn inline" aria-pressed={mode === "video"} class:primary={mode === "video"} onclick={() => switchMode("video")}>{t("record.mode.video")}</button>
      <button type="button" class="btn inline" aria-pressed={mode === "audio"} class:primary={mode === "audio"} onclick={() => switchMode("audio")}>{t("record.mode.audio")}</button>
      {#if !talk}
        <button type="button" class="btn inline" aria-pressed={mode === "text"} class:primary={mode === "text"} onclick={() => switchMode("text")}>{t("record.mode.text")}</button>
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
        id="disclosure-ack"
        type="checkbox"
        bind:checked={disclosureAck}
        style="width:auto;min-height:0;flex:none;margin-top:0.2rem"
        aria-invalid={errDisclosure}
        aria-describedby={describedBy("disclosure-ack", errDisclosure)}
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
    {#if errDisclosure}<p id="disclosure-ack-error" class="field-error">{t("record.error.disclosure")}</p>{/if}
  </div>

  <!-- Cross-event reuse gallery (F1 reuse): every intro the user recorded or wrote
       for ANY previous event, with an inline preview so they can tell them apart.
       Independent of the current mode tab — reuse bypasses the live composer. -->
  {#if !talk && !recorded && (introLibrary.length > 0 || textLibrary.length > 0)}
    <div class="card">
      <h2>{t("record.reuse.title")}</h2>
      <p class="muted">{t("record.reuse.body")}</p>
      <div class="gallery">
        {#each introLibrary as m (m.x)}
          <div class="reuse-item">
            <span class="badge">
              {m.m.startsWith("audio/") ? t("record.reuse.audioLabel") : t("record.reuse.videoLabel")}{#if m.duration} · {m.duration}s{/if}
            </span>
            <!-- On-demand: MediaPlayer decrypts + plays only when clicked. -->
            <MediaPlayer descriptor={m} />
            <div class="row" style="flex-wrap:wrap">
              <button class="btn inline" onclick={() => reuse(m, false)} disabled={busy}>{t("record.reuse.reuse")}</button>
              <button class="btn inline" onclick={() => reuse(m, true)} disabled={busy}>{t("record.reuse.fresh")}</button>
            </div>
          </div>
        {/each}
        {#each textLibrary as txt, i (i)}
          <div class="reuse-item">
            <span class="badge">{t("record.reuse.textLabel")}</span>
            <p class="excerpt">{txt}</p>
            <div class="row">
              <button class="btn inline" onclick={() => useTextFromLibrary(txt)}>{t("record.reuse.useText")}</button>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if mode === "text"}
    <div class="card">
      <h2>{t("record.text.title")}</h2>
      <p class="muted">{t("record.text.hint")}</p>
      <textarea
        id="record-text"
        rows="6"
        maxlength={MAX_INTRO_TEXT}
        placeholder={t("record.text.placeholder")}
        bind:value={textIntro}
        aria-label={t("record.text.title")}
        aria-invalid={errText}
        aria-describedby={describedBy("record-text", errText)}
      ></textarea>
      {#if errText}<p id="record-text-error" class="field-error">{t("record.error.textRequired")}</p>{/if}
      <p class="muted" style="text-align:right;font-size:0.8rem" aria-live="polite">
        {t("record.text.count", { n: textIntro.length, max: MAX_INTRO_TEXT })}
      </p>
      <button class="btn primary" onclick={submitText} disabled={busy || textLeft < 0}>
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
          <button class="btn primary" onclick={submitRecorded} disabled={busy}>
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
            <FileButton
              class="btn"
              accept={mode === "audio" ? "audio/*" : "video/*"}
              onchange={chooseFile}
              label={mode === "audio" ? t("record.chooseAudioFile") : t("record.chooseVideoFile")}
            >
              {t("record.chooseFile")}
            </FileButton>
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
  .gallery {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 0.75rem;
    margin-top: 0.5rem;
  }
  .reuse-item {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    border: 1px solid var(--border, rgba(128, 128, 128, 0.3));
    border-radius: 12px;
    background: var(--bg-elev2);
  }
  .reuse-item .badge {
    align-self: flex-start;
  }
  .excerpt {
    margin: 0;
    font-size: 0.9rem;
    white-space: pre-wrap;
    /* Show enough of the text to recognize it without letting a long intro
       dominate the gallery card. */
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
