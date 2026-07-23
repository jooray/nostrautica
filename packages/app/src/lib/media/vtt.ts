/**
 * WebVTT caption generation from a MediaTranscript (audit §7.3.6).
 *
 * The published transcript schema (`mediaTranscriptSchema`) carries only plain
 * `text` — there is no per-word/segment timing in the wire format — so we cannot
 * emit a properly time-aligned cue list. Instead we attach a SINGLE cue spanning
 * the whole media, which still gives a real, synchronized `<track kind="captions">`
 * the browser exposes through native caption UI and screen readers, rather than
 * only an offscreen transcript block. If/when segment timing is added to the
 * schema, `segmentsToVtt` below can emit multiple cues.
 *
 * LIMITATION: a single whole-duration cue is not equivalent to synchronized
 * captions; it is the best available given text-only transcript data.
 */

/** Format seconds as a WebVTT timestamp `HH:MM:SS.mmm`. */
export function vttTimestamp(seconds: number): string {
  const s = Math.max(0, seconds);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const total = Math.floor(s);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const p3 = (n: number) => String(n).padStart(3, "0");
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}.${p3(ms)}`;
}

/** Escape the handful of chars that are structural in WebVTT cue payloads. */
function escapeCue(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A single-cue WebVTT document covering the whole media duration. `durationSec`
 * falls back to a long window when unknown so the cue never ends before the
 * media does.
 */
export function singleCueVtt(text: string, durationSec = 86_400): string {
  const body = escapeCue(text.trim());
  if (!body) return "WEBVTT\n";
  return `WEBVTT\n\n${vttTimestamp(0)} --> ${vttTimestamp(durationSec)}\n${body}\n`;
}

/** Multi-cue WebVTT for future timed transcripts (segments with start/end secs). */
export function segmentsToVtt(
  segments: { start: number; end: number; text: string }[],
): string {
  const cues = segments
    .filter((seg) => seg.text.trim())
    .map(
      (seg, i) =>
        `${i + 1}\n${vttTimestamp(seg.start)} --> ${vttTimestamp(seg.end)}\n${escapeCue(
          seg.text.trim(),
        )}`,
    );
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

/** Build an object URL for a captions track from a transcript's plain text. */
export function vttObjectUrl(text: string, durationSec?: number): string {
  const blob = new Blob([singleCueVtt(text, durationSec)], { type: "text/vtt" });
  return URL.createObjectURL(blob);
}
