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
import { sweepStaleTempDirs } from "./audio.js";

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
