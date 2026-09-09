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
import { sweepStaleTempDirs, probeDurationFromBytes, ProbeUnavailableError } from "./audio.js";

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
    expect(removed).toBe(1);
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
