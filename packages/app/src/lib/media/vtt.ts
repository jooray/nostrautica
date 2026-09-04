/**
 * WebVTT caption generation from a MediaTranscript (audit §7.3.6).
 *
 * The published transcript schema (`mediaTranscriptSchema`) carries only plain
 * `text` — there is no per-word/segment timing in the wire format — so we cannot
 * emit a properly time-aligned cue list. What we CAN do, once the media's own
 * duration is known, is spread the text over that duration in proportion to how
 * much of it each chunk is: speech rate is roughly constant within one clip, so
 * a character-proportional split lands each sentence within a few seconds of
 * when it is actually said. That is a far better approximation than what this
 * module used to emit.
 *
 * It used to emit ONE cue running from 00:00:00 to 24:00:00, and MediaPlayer
 * marked the track `default` — so pressing play on a 15-minute talk painted the
 * ENTIRE transcript across the video and left it there for the whole talk. The
 * cue list below is the fix; dropping `default` (the player no longer sets it)
 * is the other half, so captions are shown when the viewer asks for them.
 *
 * LIMITATION: these are still pseudo-cues, not real alignment. If/when segment
 * timing is added to the schema, `segmentsToVtt` takes it directly.
 */

/** Format seconds as a WebVTT timestamp `HH:MM:SS.mmm`. */
export function vttTimestamp(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const total = Math.floor(s);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const p3 = (n: number) => String(n).padStart(3, "0");
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}.${p3(ms)}`;
}

/**
 * Make a string safe as a WebVTT cue PAYLOAD.
 *
 * `&<>` are markup inside a cue — that part was always handled. The part that
 * was not: a BLANK LINE TERMINATES A CUE. Any transcript with paragraphs (which
 * is most of them, and every authored one) was therefore truncated at its first
 * paragraph break, and everything after it was re-parsed as cue headers —
 * silently producing garbage cues or none at all, with no error anywhere. So
 * normalize CRLF and collapse every run of blank lines to a single newline.
 *
 * `-->` needs no separate treatment: escaping `>` already breaks it.
 */
function escapeCue(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]*(?:\n[ \t]*)+/g, "\n")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * A single-cue WebVTT document covering the whole media duration. `durationSec`
 * falls back to a long window when unknown so the cue never ends before the
 * media does — only reachable when the descriptor carries no duration at all;
 * with one, {@link timedCuesVtt} is what gets built.
 */
export function singleCueVtt(text: string, durationSec = 86_400): string {
  const body = escapeCue(text.trim());
  if (!body) return "WEBVTT\n";
  return `WEBVTT\n\n${vttTimestamp(0)} --> ${vttTimestamp(durationSec)}\n${body}\n`;
}

/** Roughly one caption's worth of text — about two spoken seconds' worth. */
const TARGET_CUE_CHARS = 180;
/** Never emit a cue shorter than this: a flash of text nobody can read. */
const MIN_CUE_SEC = 2;

/**
 * Split `text` into at most `maxCues` chunks of whole words, preferring to break
 * after sentence-ending punctuation so a cue rarely cuts mid-thought. Whitespace
 * (including the paragraph breaks `escapeCue` would otherwise have to collapse)
 * is normalized to single spaces, because a caption box is one running line of
 * text regardless of how the transcript was paragraphed.
 */
export function splitForCues(text: string, maxCues: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (maxCues <= 1) return [words.join(" ")];
  // Aim for evenly sized cues rather than filling each to TARGET_CUE_CHARS and
  // leaving a two-word runt at the end.
  const target = Math.max(1, Math.ceil(text.trim().length / maxCues));
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    current = current ? `${current} ${word}` : word;
    const endsSentence = /[.!?…](["')\]]|”)?$/.test(word);
    const full = current.length >= target;
    // Break at a sentence end once we're most of the way to the target, or
    // anywhere once we're past it — whichever comes first.
    if (chunks.length + 1 < maxCues && ((endsSentence && current.length >= target * 0.6) || full)) {
      chunks.push(current);
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Spread a plain transcript across `durationSec` as several pseudo-cues, timed
 * in proportion to each chunk's length. Requires a real, finite, positive
 * duration; callers without one want {@link singleCueVtt}.
 */
export function timedCuesVtt(text: string, durationSec: number): string {
  const trimmed = text.trim();
  if (!trimmed) return "WEBVTT\n";
  // How many cues the clip has room for, bounded by both the text's own length
  // and MIN_CUE_SEC so a 20-second clip with a long transcript doesn't get 60
  // quarter-second flashes.
  const byText = Math.ceil(trimmed.length / TARGET_CUE_CHARS);
  const byTime = Math.max(1, Math.floor(durationSec / MIN_CUE_SEC));
  const chunks = splitForCues(trimmed, Math.max(1, Math.min(byText, byTime)));
  if (chunks.length <= 1) return singleCueVtt(trimmed, durationSec);

  const totalChars = chunks.reduce((n, c) => n + c.length, 0);
  let elapsed = 0;
  const segments = chunks.map((chunk, i) => {
    const start = elapsed;
    // The last cue ends exactly at the media end — accumulated rounding must not
    // leave the closing sentence hanging a second past the video.
    elapsed =
      i === chunks.length - 1 ? durationSec : start + (chunk.length / totalChars) * durationSec;
    return { start, end: elapsed, text: chunk };
  });
  return segmentsToVtt(segments);
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

/**
 * Build an object URL for a captions track from a transcript's plain text. With
 * a usable media duration the text is spread over it (several cues); without one
 * there is nothing to spread against, so it degrades to the single long cue.
 */
export function vttObjectUrl(text: string, durationSec?: number): string {
  const timed = typeof durationSec === "number" && Number.isFinite(durationSec) && durationSec > 0;
  const vtt = timed ? timedCuesVtt(text, durationSec) : singleCueVtt(text);
  const blob = new Blob([vtt], { type: "text/vtt" });
  return URL.createObjectURL(blob);
}
