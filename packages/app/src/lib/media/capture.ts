/**
 * MediaRecorder capture (spec §10.3, F1). A single capture engine drives both the
 * video and audio-only intro paths (and, reused unchanged, Feature 2's talk
 * recording): pass the capture kind and it picks the right mimeType ladder. A
 * hard-stop timer enforces the per-event length limit; a tick callback drives the
 * visible countdown. The engine is deliberately UI-free so any composer can reuse it.
 */

export type CaptureKind = "video" | "audio";

const VIDEO_MIME_LADDER = [
  "video/mp4;codecs=avc1",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

// Audio-only ladder (F1): Opus first for size/quality, mp4/aac for Safari.
const AUDIO_MIME_LADDER = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/webm",
];

/** Pick the first supported recording mimeType for `kind`, or "" (let the UA decide). */
export function pickMimeType(kind: CaptureKind = "video"): string {
  if (typeof MediaRecorder === "undefined") return "";
  const ladder = kind === "audio" ? AUDIO_MIME_LADDER : VIDEO_MIME_LADDER;
  for (const m of ladder) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

export interface CaptureResult {
  blob: Blob;
  mime: string;
  durationSec: number;
}

export class VideoCapture {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startMs = 0;
  private hardStopTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  readonly mime: string;
  private readonly kind: CaptureKind;

  /** `kind` selects the mimeType ladder ("video" default; "audio" for audio intros). */
  constructor(kind: CaptureKind = "video") {
    this.kind = kind;
    this.mime = pickMimeType(kind);
  }

  /**
   * Start recording `stream`, hard-stopping at `maxSec`. Pass `0` (or omit —
   * defaults to unlimited) for an event with no length cap: no hard-stop timer is
   * armed and the recording runs until `stop()` is called. `onTick(elapsed)` fires
   * ~every 250ms — the seconds *remaining* for a capped recording, or the seconds
   * *elapsed* (counting up) when unlimited, so the UI always has something to show.
   * Resolves with the recording when it stops (either via stop() or the hard-stop).
   */
  start(
    stream: MediaStream,
    maxSec: number,
    onTick?: (remainingOrElapsedSec: number) => void,
  ): Promise<CaptureResult> {
    const unlimited = !maxSec || maxSec <= 0;
    this.chunks = [];
    this.recorder = new MediaRecorder(
      stream,
      this.mime ? { mimeType: this.mime } : undefined,
    );
    this.startMs = Date.now();

    return new Promise<CaptureResult>((resolve, reject) => {
      const rec = this.recorder!;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };
      rec.onerror = (e) => reject((e as any).error ?? new Error("recorder error"));
      rec.onstop = () => {
        this.cleanupTimers();
        const durationSec = Math.round((Date.now() - this.startMs) / 1000);
        const fallback = this.kind === "audio" ? "audio/webm" : "video/webm";
        const type = this.mime || this.chunks[0]?.type || fallback;
        resolve({ blob: new Blob(this.chunks, { type }), mime: type, durationSec });
      };

      rec.start(250);
      if (!unlimited) {
        this.hardStopTimer = setTimeout(() => this.stop(), maxSec * 1000);
      }
      if (onTick) {
        this.tickTimer = setInterval(() => {
          const elapsed = (Date.now() - this.startMs) / 1000;
          onTick(unlimited ? Math.floor(elapsed) : Math.max(0, Math.ceil(maxSec - elapsed)));
        }, 250);
      }
    });
  }

  /** Stop recording early (before the hard-stop). Safe to call once. */
  stop(): void {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.cleanupTimers();
  }

  private cleanupTimers(): void {
    if (this.hardStopTimer) clearTimeout(this.hardStopTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.hardStopTimer = null;
    this.tickTimer = null;
  }
}
