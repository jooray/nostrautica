/**
 * MediaRecorder capture (spec §10.3). mimeType ladder prefers Safari-friendly
 * mp4/avc1, then vp9/webm, then plain webm. A hard-stop timer enforces the
 * per-event length limit; a tick callback drives the visible countdown.
 */

const MIME_LADDER = [
  "video/mp4;codecs=avc1",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

/** Pick the first supported recording mimeType, or "" to let the UA decide. */
export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of MIME_LADDER) {
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
  readonly mime = pickMimeType();

  /**
   * Start recording `stream`, hard-stopping at `maxSec`. `onTick(remaining)` fires
   * ~every 250ms with the seconds remaining (for the countdown). Resolves with the
   * recording when it stops (either via stop() or the hard-stop).
   */
  start(
    stream: MediaStream,
    maxSec: number,
    onTick?: (remainingSec: number) => void,
  ): Promise<CaptureResult> {
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
        const type = this.mime || this.chunks[0]?.type || "video/webm";
        resolve({ blob: new Blob(this.chunks, { type }), mime: type, durationSec });
      };

      rec.start(250);
      this.hardStopTimer = setTimeout(() => this.stop(), maxSec * 1000);
      if (onTick) {
        this.tickTimer = setInterval(() => {
          const elapsed = (Date.now() - this.startMs) / 1000;
          onTick(Math.max(0, Math.ceil(maxSec - elapsed)));
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
