/**
 * ffmpeg audio extraction (spec §9.2). Extract audio, downmix to mono 16 kHz
 * Opus/OGG to fit under the provider's byte limit (25 MB for Venice); segment
 * long talks and transcribe each segment, concatenating the transcripts.
 *
 * ffmpeg is assumed present and verified at startup (spec §9).
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Hard limits for attacker-controlled media (audit C3). */
export const FFMPEG_TIMEOUT_MS = 120_000; // wall-clock kill for a hung/adversarial input
/**
 * Input hardening for every ffmpeg/ffprobe invocation (2026-09-04 audit).
 *
 * The bytes we hand ffmpeg are attacker-chosen: an attendee uploads them, we
 * decrypt them, and until now the format was fully auto-probed. ffmpeg is not
 * merely a decoder — several of its demuxers are INTERPRETERS. A blob whose
 * *content* is an HLS playlist or an `ffconcat` script is demuxed as one and its
 * segment references are resolved, so the file could name local paths; the decoded
 * audio is then transcribed and the transcript published on the attendee's own
 * 31603, which makes it a working read-and-publish channel for anything readable
 * by the daemon user — `coordinator.toml`, `.env`, database fragments.
 *
 * `-protocol_whitelist file` confines it to the one temp file we wrote.
 * `-probesize`/`-analyzeduration` bound how much of a hostile container ffmpeg
 * will chew through before giving up.
 */
const FFMPEG_INPUT_GUARD = [
  "-protocol_whitelist", "file",
  "-probesize", "5M",
  "-analyzeduration", "5M",
];

/**
 * Wall-clock budget for a metadata-only ffprobe. Far shorter than
 * {@link FFMPEG_TIMEOUT_MS}, which is sized for transcoding an hour of video:
 * reading `format=duration` under a 5M probesize is milliseconds' work, and a
 * probe that has not answered in fifteen seconds is a wedged host, not a slow
 * file. Getting that verdict sooner matters because it is now a RETRY rather than
 * a permanent rejection.
 */
export const FFPROBE_TIMEOUT_MS = 15_000;

export const MAX_INPUT_DURATION_SEC = 2 * 60 * 60; // cap decoded duration (codec-bomb guard)
/** Cap on accumulated ffmpeg stderr (audit COORD-23): keep only the tail. */
export const MAX_STDERR_BYTES = 64 * 1024;
/** Stale temp-dir sweep: dirs older than this are removed at startup (COORD-23). */
export const STALE_TEMP_DIR_AGE_MS = 24 * 60 * 60 * 1000;

/** Verify ffmpeg is available (called at startup). */
export async function verifyFfmpeg(): Promise<void> {
  await run("ffmpeg", ["-version"]);
}

/**
 * Remove `nostrautica-*` temp dirs older than `maxAgeMs` (audit COORD-23): a
 * crash between mkdtemp and the finally-rm leaks the dir; sweep them at startup.
 * Returns the number of dirs removed.
 */
export async function sweepStaleTempDirs(maxAgeMs = STALE_TEMP_DIR_AGE_MS, now = Date.now()): Promise<number> {
  let removed = 0;
  const entries = await readdir(tmpdir(), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith("nostrautica-")) continue;
    const path = join(tmpdir(), e.name);
    const st = await stat(path).catch(() => undefined);
    if (!st || now - st.mtimeMs < maxAgeMs) continue;
    await rm(path, { recursive: true, force: true }).catch(() => {});
    removed++;
  }
  return removed;
}

/**
 * The ffprobe/ffmpeg process could not be run to a VERDICT — it timed out, was
 * killed, or could not be spawned at all.
 *
 * Deliberately distinct from "ffprobe ran and could not parse this container",
 * which is an answer about the media and is cached as a policy rejection. This is
 * an answer about the HOST, is transient, and must never be cached: one slow probe
 * (a box under load, a deploy in progress) otherwise permanently rejects an
 * attendee's recording, and re-submitting the identical blob hits the same cached
 * verdict forever.
 */
export class ProbeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeUnavailableError";
  }
}

/** Why a `run()` rejected — lets a caller tell "the tool answered no" from "the
 *  tool never answered". `exit` and `output` are answers ABOUT the input. */
export type SubprocessFailure = "timeout" | "spawn" | "exit" | "output";

export class SubprocessError extends Error {
  constructor(
    message: string,
    readonly kind: SubprocessFailure,
  ) {
    super(message);
    this.name = "SubprocessError";
  }
}

/**
 * Spawn a subprocess with NO shell, its own process group, a wall-clock kill timer,
 * and a captured-output cap (audit C3). On timeout the whole group is terminated so
 * an ffmpeg child can't outlive the parent. stdin is never a TTY (`detached` + we
 * close it) so ffmpeg can't block waiting on input.
 */
function run(
  cmd: string,
  args: string[],
  opts: { input?: Uint8Array; timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal } = {},
): Promise<{ stdout: Buffer }> {
  const timeoutMs = opts.timeoutMs ?? FFMPEG_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    // Caller already cancelled (audit R13): never spawn.
    if (opts.signal?.aborted) {
      reject(opts.signal.reason ?? new Error(`${cmd} aborted before spawn`));
      return;
    }
    // detached → child becomes a group leader; killing -pid kills the whole group.
    const child = spawn(cmd, args, { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let settled = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      kill();
      reject(new SubprocessError(`${cmd} timed out after ${timeoutMs}ms`, "timeout"));
    }, timeoutMs);
    // Caller cancellation (audit R13): kill the whole process group so a hung/slow
    // ffmpeg child can't outlive a coordinator shutdown or a retention/detach
    // teardown (systemd would otherwise wait out the cgroup stop timeout).
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupAbort();
      kill();
      reject(opts.signal?.reason ?? new Error(`${cmd} aborted`));
    };
    const cleanupAbort = () => opts.signal?.removeEventListener("abort", onAbort);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d: Buffer) => {
      outLen += d.length;
      if (outLen > maxOutputBytes) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupAbort();
        kill();
        reject(new SubprocessError(`${cmd} output exceeded ${maxOutputBytes} bytes`, "output"));
        return;
      }
      out.push(d);
    });
    // stderr is diagnostics only (audit COORD-23): an endlessly-chatty ffmpeg on
    // adversarial input must not grow memory — keep only the LAST ~64 KB.
    child.stderr.on("data", (d: Buffer) => {
      err.push(d);
      errLen += d.length;
      if (errLen > MAX_STDERR_BYTES) {
        const merged = Buffer.concat(err).subarray(-MAX_STDERR_BYTES);
        err.length = 0;
        err.push(merged);
        errLen = merged.length;
      }
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupAbort();
      // Could not spawn at all (ENOENT, EAGAIN, out of fds): about the host, not
      // about the media.
      reject(new SubprocessError(`${cmd} could not be spawned: ${e.message}`, "spawn"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupAbort();
      if (code === 0) resolve({ stdout: Buffer.concat(out) });
      else reject(new SubprocessError(`${cmd} exited ${code}: ${Buffer.concat(err).toString().slice(-500)}`, "exit"));
    });
    if (opts.input) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
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
  signal?: AbortSignal,
): Promise<AudioSegment[]> {
  const dir = await mkdtemp(join(tmpdir(), "nostrautica-"));
  try {
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    const inPath = join(dir, `in.${ext}`);
    await writeFile(inPath, media);

    // First pass: whole-file audio to mono 16 kHz Opus. `-nostdin` and a decoded-
    // duration cap (`-t`) guard against adversarial/endless inputs (audit C3).
    const wholePath = join(dir, "audio.ogg");
    await run("ffmpeg", [
      "-nostdin", "-y", ...FFMPEG_INPUT_GUARD,
      "-t", String(MAX_INPUT_DURATION_SEC), "-i", inPath,
      "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "libopus", "-b:a", "16k",
      wholePath,
    ], { signal });
    const whole = await readFile(wholePath);
    if (whole.length <= maxBytes) {
      return [{ data: new Uint8Array(whole), mime: "audio/ogg" }];
    }

    // Too big: segment. Aim each segment well under the limit by duration.
    // (No probe here: its result was computed and then discarded — `void durationSec`
    // — so it was one wasted ffprobe spawn per oversized upload, and after the
    // ProbeUnavailableError change it would also be a new way for extraction to fail
    // for a value nothing reads. Segment length is derived from the byte budget.)
    // ~16 kbit/s → ~2 KB/s; leave headroom.
    const secPerSegment = Math.max(30, Math.floor((maxBytes * 0.8) / 2048));
    const segPattern = join(dir, "seg-%03d.ogg");
    await run("ffmpeg", [
      "-nostdin", "-y", ...FFMPEG_INPUT_GUARD,
      "-t", String(MAX_INPUT_DURATION_SEC), "-i", inPath,
      "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "libopus", "-b:a", "16k",
      "-f", "segment", "-segment_time", String(secPerSegment),
      segPattern,
    ], { signal });
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

/**
 * Probed duration in seconds, or `undefined` for "could not probe" (2026-09-04
 * audit).
 *
 * This used to return 0 for BOTH — a zero-length input and a container ffprobe
 * could not parse, a timeout, a killed process, an "N/A" duration — and the
 * caller (transcribe.ts) treated 0 as a real measurement despite the comment here
 * claiming otherwise. Consequences of the conflation, for a container ffprobe
 * cannot parse but ffmpeg CAN decode: `realDurationSec > maxDurationSec` is false,
 * so the event's per-media duration cap is bypassed entirely, and `onUsage` books
 * 0 seconds against the budget that is supposed to bound the spend — while the STT
 * bill for the full-length audio is real. Those two are the whole of the H-3
 * enforcement, defeated by one unparseable header.
 *
 * `undefined` forces every caller to decide, and TypeScript makes them.
 *
 * THIRD case, added 2026-09-09: `undefined` was ALSO covering "ffprobe never
 * answered" — a timeout, a kill, a failed spawn. The caller turns `undefined` into
 * a permanent media-policy rejection with a cached empty transcript, so one slow
 * probe on a loaded host meant an attendee's recording was never transcribed and
 * re-submitting the identical blob hit the same cached verdict, forever. That is a
 * fact about the HOST being recorded as a fact about the media, which is the
 * transient-failure-as-truth pattern this whole audit round is about. It now
 * throws {@link ProbeUnavailableError}, which is retryable and never cached.
 *
 * A non-zero EXIT stays `undefined`: that is ffprobe answering "I cannot parse
 * this", which is exactly the container-that-defeats-the-probe case the 09-04
 * audit decided to reject rather than wave through.
 */
async function probeDurationSec(
  path: string,
  signal?: AbortSignal,
  timeoutMs = FFPROBE_TIMEOUT_MS,
): Promise<number | undefined> {
  let stdout: Buffer;
  try {
    ({ stdout } = await run("ffprobe", [
      "-v", "error", ...FFMPEG_INPUT_GUARD,
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", path,
    ], { signal, timeoutMs }));
  } catch (e) {
    // Caller cancellation (shutdown, retention teardown) unwinds as itself.
    if (signal?.aborted) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    // Logged, because "could not probe" now has a policy consequence and an
    // operator staring at a rejected intro needs to see WHY (a timeout and a
    // malformed container want different responses).
    console.warn(`[audio] ffprobe failed: ${msg}`);
    if (e instanceof SubprocessError && (e.kind === "timeout" || e.kind === "spawn")) {
      throw new ProbeUnavailableError(msg);
    }
    return undefined;
  }
  // ffprobe exits 0 and prints "N/A" for a stream whose duration it cannot
  // determine; `parseFloat("N/A") || 0` silently made that a confident zero.
  const sec = parseFloat(stdout.toString().trim());
  if (!Number.isFinite(sec) || sec < 0) {
    console.warn(`[audio] ffprobe reported no usable duration (${JSON.stringify(stdout.toString().trim().slice(0, 40))})`);
    return undefined;
  }
  return Math.ceil(sec);
}

/**
 * Probe the REAL decoded duration (seconds) of a media blob (audit H-3). The
 * coordinator enforces the event's duration limit against this, not the
 * attendee-declared `duration`, before spending on STT. Returns `undefined` when
 * ffprobe could not determine a duration at all — which is NOT the same as 0, and
 * is a rejection rather than a pass wherever a limit is configured (see
 * transcribe.ts). Writes to a temp file (ffprobe needs a seekable input) and
 * always cleans it up.
 */
export async function probeDurationFromBytes(
  media: Uint8Array,
  mime: string,
  signal?: AbortSignal,
  timeoutMs = FFPROBE_TIMEOUT_MS,
): Promise<number | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "nostrautica-probe-"));
  try {
    const ext = mime.includes("mp4") ? "mp4" : mime.includes("webm") ? "webm" : "bin";
    const inPath = join(dir, `probe.${ext}`);
    await writeFile(inPath, media);
    return await probeDurationSec(inPath, signal, timeoutMs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
