/**
 * ffmpeg audio extraction (spec §9.2). Extract audio, downmix to mono 16 kHz
 * Opus/OGG to fit under the provider's byte limit (25 MB for Venice); segment
 * long talks and transcribe each segment, concatenating the transcripts.
 *
 * ffmpeg is assumed present and verified at startup (spec §9).
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Verify ffmpeg is available (called at startup). */
export async function verifyFfmpeg(): Promise<void> {
  await run("ffmpeg", ["-version"]);
}

function run(cmd: string, args: string[], input?: Uint8Array): Promise<{ stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(out) });
      else reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString().slice(-500)}`));
    });
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

export interface AudioSegment {
  data: Uint8Array;
  mime: string;
}

/**
 * Extract mono 16 kHz Opus/OGG audio from a media blob. If the result would
 * exceed `maxBytes`, split into time segments that each fit.
 */
export async function extractAudioSegments(
  media: Uint8Array,
  mime: string,
  maxBytes: number,
): Promise<AudioSegment[]> {
  const dir = await mkdtemp(join(tmpdir(), "nostrautica-"));
  try {
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    const inPath = join(dir, `in.${ext}`);
    await writeFile(inPath, media);

    // First pass: whole-file audio to mono 16 kHz Opus.
    const wholePath = join(dir, "audio.ogg");
    await run("ffmpeg", [
      "-y", "-i", inPath,
      "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "libopus", "-b:a", "16k",
      wholePath,
    ]);
    const whole = await readFile(wholePath);
    if (whole.length <= maxBytes) {
      return [{ data: new Uint8Array(whole), mime: "audio/ogg" }];
    }

    // Too big: segment. Aim each segment well under the limit by duration.
    const durationSec = await probeDurationSec(inPath);
    // ~16 kbit/s → ~2 KB/s; leave headroom.
    const secPerSegment = Math.max(30, Math.floor((maxBytes * 0.8) / 2048));
    const segPattern = join(dir, "seg-%03d.ogg");
    await run("ffmpeg", [
      "-y", "-i", inPath,
      "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "libopus", "-b:a", "16k",
      "-f", "segment", "-segment_time", String(secPerSegment),
      segPattern,
    ]);
    void durationSec;
    const files = (await readdir(dir)).filter((f) => f.startsWith("seg-")).sort();
    const segments: AudioSegment[] = [];
    for (const f of files) {
      const buf = await readFile(join(dir, f));
      segments.push({ data: new Uint8Array(buf), mime: "audio/ogg" });
    }
    return segments;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function probeDurationSec(path: string): Promise<number> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", path,
    ]);
    return Math.ceil(parseFloat(stdout.toString()) || 0);
  } catch {
    return 0;
  }
}
