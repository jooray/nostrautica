import { describe, it, expect } from "vitest";
import { vttTimestamp, singleCueVtt, segmentsToVtt } from "./vtt.js";

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
