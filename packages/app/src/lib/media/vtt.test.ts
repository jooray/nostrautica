import { describe, it, expect, vi } from "vitest";
import {
  vttTimestamp,
  singleCueVtt,
  segmentsToVtt,
  timedCuesVtt,
  vttObjectUrl,
} from "./vtt.js";

describe("vtt", () => {
  it("formats timestamps as HH:MM:SS.mmm", () => {
    expect(vttTimestamp(0)).toBe("00:00:00.000");
    expect(vttTimestamp(65.5)).toBe("00:01:05.500");
    expect(vttTimestamp(3661.007)).toBe("01:01:01.007");
    expect(vttTimestamp(-5)).toBe("00:00:00.000"); // clamped
  });

  it("builds a single whole-duration cue from plain transcript text", () => {
    const vtt = singleCueVtt("Hi, I build privacy tools.", 42);
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:42.000");
    expect(vtt).toContain("Hi, I build privacy tools.");
  });

  it("escapes VTT-structural characters in the cue body", () => {
    expect(singleCueVtt("a < b & c > d")).toContain("a &lt; b &amp; c &gt; d");
  });

  it("emits only the header for empty/whitespace text", () => {
    expect(singleCueVtt("   ")).toBe("WEBVTT\n");
  });

  it("segmentsToVtt emits one numbered cue per timed segment", () => {
    const vtt = segmentsToVtt([
      { start: 0, end: 2, text: "one" },
      { start: 2, end: 4, text: "two" },
    ]);
    expect(vtt).toContain("1\n00:00:00.000 --> 00:00:02.000\none");
    expect(vtt).toContain("2\n00:00:02.000 --> 00:00:04.000\ntwo");
  });
});

describe("vtt cue-body sanitizing (blank lines)", () => {
  it("collapses blank lines so a multi-paragraph transcript is not truncated", () => {
    // A blank line TERMINATES a WebVTT cue: with the paragraph break intact the
    // browser parsed only "One." as the cue and re-read the rest as cue headers,
    // so everything after the first paragraph vanished from the captions.
    const vtt = singleCueVtt("One.\n\nTwo.\n\n\nThree.", 30);
    expect(vtt).toContain("Three.");
    // Exactly one cue: header, blank line, timing line, then the body.
    const [header, ...rest] = vtt.trimEnd().split("\n\n");
    expect(header).toBe("WEBVTT");
    expect(rest).toHaveLength(1);
    expect(rest[0]).toBe("00:00:00.000 --> 00:00:30.000\nOne.\nTwo.\nThree.");
  });

  it("normalizes CRLF paragraph breaks too", () => {
    expect(singleCueVtt("A.\r\n\r\nB.", 10)).toContain("A.\nB.");
  });
});

describe("timedCuesVtt (pseudo-alignment over the real duration)", () => {
  // ~30 sentences: long enough that one 24-hour cue was the whole transcript
  // painted over the video for the entire clip.
  const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} of the talk.`).join(" ");

  it("emits several cues spread across the media duration, not one 24h cue", () => {
    const vtt = timedCuesVtt(long, 900);
    expect(vtt).not.toContain("24:00:00.000");
    const cues = vtt.trimEnd().split("\n\n").slice(1);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0]).toContain("00:00:00.000 --> ");
    // The last cue lands exactly on the end of the media (900s = 00:15:00).
    expect(cues[cues.length - 1]).toContain(" --> 00:15:00.000");
  });

  it("cues are contiguous, forward-ordered and inside the duration", () => {
    const vtt = timedCuesVtt(long, 900);
    const times = [...vtt.matchAll(/(\d\d:\d\d:\d\d\.\d\d\d) --> (\d\d:\d\d:\d\d\.\d\d\d)/g)].map(
      (m) => [m[1]!, m[2]!] as const,
    );
    const secs = (t: string) => {
      const [h, m, s] = t.split(":");
      return Number(h) * 3600 + Number(m) * 60 + Number(s);
    };
    let prevEnd = 0;
    for (const [start, end] of times) {
      expect(secs(start)).toBeCloseTo(prevEnd, 2);
      expect(secs(end)).toBeGreaterThan(secs(start));
      prevEnd = secs(end);
    }
    expect(prevEnd).toBe(900);
  });

  it("never emits a cue shorter than a readable flash on a short clip", () => {
    // 20s of media, lots of text: capped at duration/2s cues, not 1 per sentence.
    const vtt = timedCuesVtt(long, 20);
    const cues = vtt.trimEnd().split("\n\n").slice(1);
    expect(cues.length).toBeLessThanOrEqual(10);
  });

  it("falls back to one cue when the text fits in one", () => {
    expect(timedCuesVtt("Short.", 60)).toContain("00:00:00.000 --> 00:01:00.000\nShort.");
  });
});

describe("vttObjectUrl duration handling", () => {
  /** Capture the VTT text vttObjectUrl hands to the Blob, without a real URL. */
  async function builtVtt(text: string, durationSec?: number): Promise<string> {
    let blob: Blob | null = null;
    vi.stubGlobal("URL", {
      createObjectURL: (b: Blob) => {
        blob = b;
        return "blob:stub";
      },
      revokeObjectURL: () => {},
    });
    try {
      vttObjectUrl(text, durationSec);
      return await (blob as unknown as Blob).text();
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("spreads the transcript over the media's real duration", async () => {
    const vtt = await builtVtt("One. Two. Three.", 90);
    expect(vtt).toContain("WEBVTT");
    // The regression this replaces: one cue running to 24:00:00.
    expect(vtt).not.toContain("24:00:00.000");
    expect(vtt).toContain("00:01:30.000");
  });

  it("degrades to the long single cue when the duration is unknown or bogus", async () => {
    for (const bad of [undefined, 0, Number.POSITIVE_INFINITY, Number.NaN, -5]) {
      expect(await builtVtt("One. Two.", bad as number | undefined)).toContain("24:00:00.000");
    }
  });
});
