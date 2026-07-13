<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { MediaDescriptor } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, type EventContext } from "$lib/events/event-context.js";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import { VideoCapture } from "$lib/media/capture.js";
  import EventHeader from "$lib/components/EventHeader.svelte";
  import {
    uploadMedia,
    submitProfileAndMedia,
    loadSelfCopy,
    loadLibrary,
    prepareReuse,
  } from "$lib/media/submit.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { naddr, talk }: { naddr: string; talk: boolean } = $props();
  const kind = $derived<"intro" | "talk">(talk ? "talk" : "intro");
  const kindLabel = $derived(talk ? t("record.kind.talk") : t("record.kind.intro"));

  let ctx = $state<EventContext | null>(null);
  let error = $state<string | null>(null);
  let videoEl = $state<HTMLVideoElement | null>(null);
  let stream: MediaStream | null = null;
  let capture: VideoCapture | null = null;

  let recording = $state(false);
  let remaining = $state(0);
  let recorded = $state<{ blob: Blob; url: string; durationSec: number } | null>(null);
  let busy = $state(false);
  let done = $state(false);
  let library = $state<MediaDescriptor[]>([]);

  const maxSec = $derived(ctx ? (talk ? ctx.config.maxTalkSec : ctx.config.maxVideoSec) : 90);

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      if (session.signer) {
        const bk = await deriveBlindingKey(session.signer);
        library = await loadLibrary(session.signer, bk);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  onDestroy(() => stopStream());

  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  async function enableCamera() {
    error = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (videoEl) {
        videoEl.srcObject = stream;
        videoEl.muted = true;
        await videoEl.play().catch(() => {});
      }
    } catch (e) {
      error = t("record.error.camera", { reason: (e as Error).message });
    }
  }

  async function startRecording() {
    if (!stream) await enableCamera();
    if (!stream) return;
    capture = new VideoCapture();
    recording = true;
    remaining = maxSec;
    try {
      const result = await capture.start(stream, maxSec, (r) => (remaining = r));
      recording = false;
      recorded = {
        blob: result.blob,
        url: URL.createObjectURL(result.blob),
        durationSec: result.durationSec,
      };
    } catch (e) {
      recording = false;
      error = (e as Error).message;
    }
  }

  function stopRecording() {
    capture?.stop();
  }

  function reRecord() {
    if (recorded) URL.revokeObjectURL(recorded.url);
    recorded = null;
  }

  async function submitRecorded() {
    if (!ctx || !session.signer || !recorded) return;
    busy = true;
    error = null;
    try {
      const bk = await deriveBlindingKey(session.signer);
      const descriptor = await uploadMedia(
        session.signer,
        ctx,
        recorded.blob,
        kind,
        recorded.durationSec,
      );
      await finishSubmit(descriptor);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
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
      await finishSubmit(prepared);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function finishSubmit(descriptor: MediaDescriptor) {
    const signer = session.signer!;
    const bk = await deriveBlindingKey(signer);
    const self = await loadSelfCopy(signer, ctx!, bk);
    const existingMedia = (self?.media ?? []).filter((m) => m.kind !== descriptor.kind);
    await submitProfileAndMedia(signer, ctx!, {
      profile: self?.profile ?? { about: "", skills: [], looking_for: "", links: [] },
      media: [...existingMedia, descriptor],
      blindingKey: bk,
    });
    stopStream();
    done = true;
  }
</script>

{#if ctx}<EventHeader {ctx} compact link />{/if}
<h1>{talk ? t("record.talk.title") : t("record.intro.title")}</h1>

{#if error}<div class="card warn">{error}</div>{/if}

{#if done}
  <div class="card">
    <p>{t("record.uploaded", { kind: kindLabel })}</p>
    <button class="btn primary" onclick={() => router.go({ name: "event", naddr })}>
      {t("record.backToEvent")}
    </button>
  </div>
{:else if !session.loggedIn}
  <div class="card">
    <button class="btn primary" onclick={() => router.go({ name: "login" })}>{t("record.loginFirst")}</button>
  </div>
{:else}
  {#if library.length > 0 && !recorded}
    <div class="card">
      <h2>{t("record.reuse.title")}</h2>
      <p class="muted">{t("record.reuse.body")}</p>
      {#each library as m (m.x)}
        <div class="row" style="justify-content:space-between;margin-top:0.5rem">
          <span class="badge">{m.kind === "talk" ? t("record.kind.talk") : t("record.kind.intro")} · {m.duration ?? "?"}s</span>
          <div class="row">
            <button class="btn inline" onclick={() => reuse(m, false)} disabled={busy}>{t("record.reuse.reuse")}</button>
            <button class="btn inline" onclick={() => reuse(m, true)} disabled={busy}>{t("record.reuse.fresh")}</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <div class="card">
    {#if recorded}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video src={recorded.url} controls playsinline style="max-width:100%;border-radius:12px"></video>
      <p class="muted">{t("record.recorded", { sec: recorded.durationSec })}</p>
      <div class="row">
        <button class="btn" onclick={reRecord} disabled={busy}>{t("record.reRecord")}</button>
        <button class="btn primary" onclick={submitRecorded} disabled={busy}>
          {busy ? t("record.uploading") : t("record.useThis")}
        </button>
      </div>
    {:else}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={videoEl} playsinline muted style="max-width:100%;border-radius:12px;background:#000"></video>
      <p class="muted">
        {t("record.limit", { sec: maxSec })}
        {#if recording}<strong>{t("record.timeLeft", { sec: remaining })}</strong>{/if}
      </p>
      {#if recording}
        <button class="btn danger" onclick={stopRecording}>{t("record.stop")}</button>
      {:else}
        <div class="row">
          <button class="btn" onclick={enableCamera}>{t("record.enableCamera")}</button>
          <button class="btn primary" onclick={startRecording}>{t("record.record")}</button>
        </div>
      {/if}
    {/if}
  </div>
{/if}
