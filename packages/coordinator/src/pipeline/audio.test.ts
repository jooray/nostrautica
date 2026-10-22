/**
 * Temp-dir hygiene for ffmpeg extraction (audit COORD-23): a crash between
 * mkdtemp and cleanup leaks a `nostrautica-*` dir; the startup sweep removes
 * stale ones and leaves fresh ones (and everything else) alone.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, utimes, rmdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { encryptMedia } from "@nostrautica/protocol";
import { sweepStaleTempDirs, probeDurationFromBytes, ProbeUnavailableError, extractAudioSegments } from "./audio.js";
import { transcribeMedia, MediaPolicyError } from "./transcribe.js";
import { Store } from "../store/db.js";
import { MockStt } from "../providers/mock.js";

const created: string[] = [];

afterEach(async () => {
  for (const d of created.splice(0)) await rmdir(d).catch(() => {});
});

describe("sweepStaleTempDirs (audit COORD-23)", () => {
  it("removes stale nostrautica-* dirs, keeps fresh dirs and foreign entries", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const stale = await mkdtemp(join(tmpdir(), "nostrautica-stale-"));
    const fresh = await mkdtemp(join(tmpdir(), "nostrautica-fresh-"));
    const foreign = join(tmpdir(), `other-${Date.now()}`);
    await mkdir(foreign);
    created.push(stale, fresh, foreign);

    // Age the stale dir beyond the sweep threshold.
    const old = new Date(Date.now() - 2 * DAY);
    await utimes(stale, old, old);

    const now = Date.now();
    const removed = await sweepStaleTempDirs(DAY, now);
    // NOT toBe(1): the sweep is over the SHARED system tmpdir, so the count also
    // includes any aged `nostrautica-*` dir another test or an earlier run left
    // behind. Asserting the exact total made this pass on a clean machine and
    // fail a day later on a working one. What this test actually owns is the
    // three dirs below.
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });
});

/**
 * "ffprobe said no" and "ffprobe never answered" are different answers
 * (2026-09-09 audit, PIPE-N-1).
 *
 * The 09-04 fix correctly stopped returning 0 for a failed probe, but collapsed
 * both failures into `undefined` — and the caller turns `undefined` into a
 * permanent media-policy rejection with a cached empty transcript. So a probe that
 * timed out on a loaded host was recorded as a fact about the media: the recording
 * was never transcribed, and re-submitting the identical blob hit the same cached
 * verdict forever.
 */
describe("probeDurationFromBytes failure classification", () => {
  const GARBAGE = new Uint8Array(64).fill(0x41); // not a media container

  it("returns undefined when ffprobe RAN and could not parse the input", async () => {
    // A real ffprobe invocation, exiting non-zero: the container-that-defeats-the-
    // probe case the 09-04 audit deliberately rejects rather than waves through.
    await expect(probeDurationFromBytes(GARBAGE, "video/webm")).resolves.toBeUndefined();
  });

  it("throws ProbeUnavailableError when ffprobe never ANSWERED (a timeout)", async () => {
    // A 1 ms budget cannot outlast a process spawn, so this is the timeout arm.
    // The distinction is the whole point: this must not reach the caller as
    // `undefined`, which is what gets cached as a permanent policy rejection.
    await expect(probeDurationFromBytes(GARBAGE, "video/webm", undefined, 1)).rejects.toBeInstanceOf(
      ProbeUnavailableError,
    );
  });
});

/**
 * Audit R-65: `-protocol_whitelist file` alone let ffmpeg auto-probe any demuxer,
 * including the ones that follow references to other files. The probe is now
 * confined to a fixed list of plain containers.
 */
describe("ffmpeg demuxer allowlist (R-65)", () => {
  function make(args: string[], name: string): Uint8Array {
    const dir = mkdtempSync(join(tmpdir(), "r65-"));
    try {
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=d=2", ...args, join(dir, name)]);
      return new Uint8Array(readFileSync(join(dir, name)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("refuses a blob that sniffs as an ffconcat script, in the probe and in extraction", async () => {
    const script = new TextEncoder().encode("ffconcat version 1.0\nfile in.webm\n");
    await expect(probeDurationFromBytes(script, "audio/webm")).resolves.toBeUndefined();
    await expect(extractAudioSegments(script, "audio/webm", 1 << 20)).rejects.toThrow(/whitelist/);
  });

  it("still decodes the containers the apps and file pickers produce, whatever mime they carry", async () => {
    const samples: [Uint8Array, string][] = [
      [make(["-c:a", "libopus"], "a.webm"), "audio/webm"],
      [make(["-c:a", "aac"], "a.m4a"), "audio/mp4"],
      [make(["-c:a", "aac"], "a.mp4"), "video/quicktime"],
      [make(["-c:a", "libopus"], "a.ogg"), "audio/ogg"],
      [make([], "a.wav"), "audio/x-wav"],
    ];
    for (const [media, mime] of samples) {
      expect([2, 3]).toContain(await probeDurationFromBytes(media, mime)); // ceil of 2.0xx
      const segs = await extractAudioSegments(media, mime, 1 << 20);
      expect(segs[0]!.durationSec).toBeGreaterThan(1.5);
    }
  });
});

/**
 * Audit R-17: `format=duration` is container metadata the uploader wrote. A WebM
 * whose Duration element says 1 s over 10 s of audio passed a 3 s cap and booked
 * 1 s while STT was billed for all ten.
 */
describe("a lying container duration does not get past the cap (R-17)", () => {
  /** 10 s of Opus in WebM, its EBML Duration patched to claim 1 s. */
  function lyingWebm(): Uint8Array {
    const dir = mkdtempSync(join(tmpdir(), "r17-"));
    try {
      const path = join(dir, "long.webm");
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=d=10", "-c:a", "libopus", "-b:a", "16k", path]);
      const b = readFileSync(path);
      const i = b.indexOf(Buffer.from([0x44, 0x89])); // Segment Info → Duration
      expect(b[i + 2]).toBe(0x88); // an 8-byte float, in TimecodeScale (ms) units
      b.writeDoubleBE(1000, i + 3);
      return new Uint8Array(b);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("the container claims 1 s; extraction stops past the cap and measures what it decoded", async () => {
    const media = lyingWebm();
    expect(await probeDurationFromBytes(media, "audio/webm")).toBe(1);
    const segments = await extractAudioSegments(media, "audio/webm", 25 * 1024 * 1024, undefined, 3);
    const measured = segments.reduce((n, s) => n + (s.durationSec ?? 0), 0);
    expect(measured).toBeGreaterThan(3.5); // decoded to the 4 s input cap, not the claimed 1 s
    expect(measured).toBeLessThan(5);
  });

  it("transcribeMedia rejects it before STT and books the measured seconds", async () => {
    const { ciphertext, descriptor } = await encryptMedia({
      kind: "intro", data: lyingWebm(), mime: "audio/webm", duration: 1, urls: ["https://blob.example/x"],
    });
    const stt = new MockStt({ default: "x" });
    const usage: { bytes: number; durationSec: number }[] = [];
    await expect(
      transcribeMedia(
        { store: new Store(":memory:"), stt, sttModel: "m", fetchBlob: async () => ciphertext, maxDurationSec: 3, onUsage: (u) => usage.push(u) },
        descriptor as never,
      ),
    ).rejects.toThrow(MediaPolicyError);
    expect(stt.calls).toBe(0);
    expect(usage.reduce((n, u) => n + u.durationSec, 0)).toBe(4);
  });
});
