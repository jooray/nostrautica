/**
 * Transcription stage (spec §9.2). Fetch the encrypted blob from Blossom, verify
 * + decrypt it, extract mono 16 kHz Opus audio (segmenting to fit the provider's
 * byte limit), transcribe each segment, and concatenate. Cached by blob sha256
 * so a restart never re-pays for a transcript.
 */
import { decryptMedia, sha256Hex, type MediaDescriptor,
  MAX_MEDIA_FILE_BYTES,
} from "@nostrautica/protocol";
import type { SttProvider } from "../providers/types.js";
import type { Store } from "../store/db.js";
import {
  extractAudioSegments,
  probeDurationFromBytes,
  ProbeUnavailableError,
  type AudioSegment,
} from "./audio.js";
import { safeFetch, SafeFetchError } from "../net/safe-fetch.js";

/** Default hard ceiling on a downloaded media blob (audit C3). */
export const DEFAULT_MAX_MEDIA_BYTES = MAX_MEDIA_FILE_BYTES;

/**
 * Above this many bytes of EXTRACTED audio, an empty transcript is treated as a
 * provider failure rather than as silence, and is not cached (see the end of
 * {@link transcribeMedia}). The extraction pipeline emits 16 kbit/s mono Opus, so
 * ~2 KB per second of audio: 8 KB is roughly four seconds — long enough that a
 * person who bothered to record it said something, short enough that a genuinely
 * blank clip still caches on the first try.
 */
export const MIN_AUDIO_BYTES_TO_EXPECT_SPEECH = 8 * 1024;

/**
 * The media violates the coordinator's declared policy (audit H-3): the actual
 * downloaded ciphertext length doesn't match the descriptor's `size`, or the real
 * decoded duration exceeds the event limit. The media is REJECTED (marked
 * processed with an empty transcript, no STT) — it is not a transient failure, so
 * it must never retry/poison the whole attendee. Actual downloaded bytes are still
 * accounted (abuse is metered even on rejection).
 */
export class MediaPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaPolicyError";
  }
}

export interface BlobFetchOptions {
  /** Blossom origins the coordinator may fetch from (empty = any public https host). */
  allowedOrigins?: string[];
  maxBytes?: number;
  /** Caller cancellation (audit R13): shutdown / per-event teardown. */
  signal?: AbortSignal;
  /**
   * The guarded downloader, injectable for tests — the same shape every other
   * expensive dependency in this pipeline takes (`probeDuration`, `extractAudio`,
   * `fetchBlob` itself one level up). Defaults to the real `safeFetch`.
   */
  fetch?: typeof safeFetch;
}

/**
 * Download ciphertext from the first reachable mirror, verifying the hash. Uses
 * the SSRF/DoS-guarded downloader (audit C3): https-only, Blossom-origin
 * allowlist, private-IP rejection, redirect cap, timeout, and streamed byte cap.
 * A policy rejection is a permanent failure (do not retry other mirrors past a
 * hard block); a transient network/DNS failure falls through to the next mirror.
 */
export async function fetchBlob(
  urls: string[],
  expectedSha256: string,
  opts: BlobFetchOptions = {},
): Promise<Uint8Array> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  const get = opts.fetch ?? safeFetch;
  let lastErr: unknown;
  // Whether EVERY mirror failed for a reason another attempt cannot change: a hash
  // that doesn't match the descriptor, a host the allowlist refuses, a body that
  // ran past the byte cap. One retryable failure anywhere (a DNS blip, a 502) and
  // this stays false, because then retrying really can work.
  let allPermanent = urls.length > 0;
  for (const url of urls) {
    try {
      const bytes = await get(url, { allowedOrigins: opts.allowedOrigins, maxBytes, signal: opts.signal });
      if (sha256Hex(bytes) !== expectedSha256) {
        // The bytes arrived and are not the bytes the descriptor names. No number
        // of retries changes that; the blob is either corrupt or substituted.
        lastErr = new Error(`hash mismatch from ${url}`);
        continue;
      }
      return bytes;
    } catch (e) {
      lastErr = e;
      // A non-retryable policy rejection on ONE mirror doesn't necessarily doom the
      // others (a different mirror may be an allowlisted host), so keep trying —
      // but never widen the target set beyond the descriptor's declared urls.
      if (e instanceof SafeFetchError && !e.retryable) continue;
      allPermanent = false;
    }
  }
  const why = `could not fetch blob ${expectedSha256}: ${lastErr}`;
  // MED-5's other half. This threw a plain Error whatever the reason, and
  // `processAttendee` rethrows anything that is not a MediaPolicyError — so a blob
  // that can NEVER be fetched (corrupt, substituted, on a host the allowlist
  // refuses, or larger than the cap) failed the whole attendee job and re-ran it on
  // the retry schedule: up to 26 full downloads of every mirror over three days,
  // for an answer that was settled on the first one. As a policy rejection it costs
  // that media only, and the attendee keeps their profile and their other media.
  throw allPermanent ? new MediaPolicyError(why) : new Error(why);
}

export interface TranscribeDeps {
  store: Store;
  stt: SttProvider;
  sttModel: string;
  /** Injectable for tests; defaults to a real Blossom fetch. */
  fetchBlob?: (urls: string[], sha256: string) => Promise<Uint8Array>;
  /** Blossom origins media may be fetched from (audit C3 allowlist). */
  blossomOrigins?: string[];
  /** Max media bytes per blob download (audit C3). */
  maxMediaBytes?: number;
  /**
   * Real decoded-duration limit for THIS media kind (audit H-3): after decrypt the
   * coordinator probes the actual duration and rejects media exceeding this,
   * regardless of the attendee-declared `duration`. Intro and talk limits are
   * passed distinctly by the caller. 0/undefined ⇒ no duration enforcement.
   */
  maxDurationSec?: number;
  /** Injectable duration probe (tests); defaults to ffprobe on the decrypted bytes.
   *  `undefined` means "could not probe" — NOT zero seconds; see the enforcement
   *  below, which rejects an unprobeable input wherever a limit is configured. */
  probeDuration?: (media: Uint8Array, mime: string) => Promise<number | undefined>;
  /** Injectable audio extraction (tests); defaults to the real ffmpeg pipeline. */
  extractAudio?: (media: Uint8Array, mime: string, maxBytes: number) => Promise<AudioSegment[]>;
  /**
   * Account the ACTUAL downloaded bytes + probed duration into the usage budgets
   * (audit H-2/H-3): declared values are never trusted for accounting. Called even
   * when the media is rejected (bytes were still spent downloading).
   */
  onUsage?: (usage: { bytes: number; durationSec: number }) => void;
  /** Caller cancellation (audit R13): threaded into the blob download, ffprobe/ffmpeg
   *  child processes, and the STT provider call so a shutdown/teardown unwinds a
   *  long transcription promptly instead of running to its provider deadline. */
  signal?: AbortSignal;
  now?: () => number;
}

/** A transcript plus the STT-detected source language (spec F1, audit A1). */
export interface TranscriptResult {
  text: string;
  lang?: string;
}

/**
 * Transcribe one media descriptor, using and updating the transcript cache.
 * Returns the transcript text and the STT-detected language (when the provider
 * reports one) so the coordinator can publish a language-tagged transcript.
 */
export async function transcribeMedia(
  deps: TranscribeDeps,
  descriptor: MediaDescriptor,
): Promise<TranscriptResult> {
  const now = deps.now ?? (() => Date.now());
  const cached = deps.store.getTranscriptRow(descriptor.x);
  if (cached !== undefined) return { text: cached.text, lang: cached.lang ?? undefined };

  deps.signal?.throwIfAborted();
  const download =
    deps.fetchBlob ??
    ((urls: string[], sha: string) =>
      fetchBlob(urls, sha, { allowedOrigins: deps.blossomOrigins, maxBytes: deps.maxMediaBytes, signal: deps.signal }));
  const ciphertext = await download(descriptor.url, descriptor.x);

  // H-3: the actual downloaded ciphertext length MUST equal the declared `size`.
  // A mismatch means the descriptor lied (a declared `size: 1` fronting a huge blob
  // to duck the aggregate byte budget). Account the bytes actually spent, then
  // reject this media (empty cached transcript, no decrypt/STT).
  if (ciphertext.length !== descriptor.size) {
    deps.onUsage?.({ bytes: ciphertext.length, durationSec: 0 });
    deps.store.putTranscript(descriptor.x, "", now());
    throw new MediaPolicyError(
      `declared size ${descriptor.size} != actual ciphertext length ${ciphertext.length}`,
    );
  }

  const plaintext = await decryptMedia(descriptor, ciphertext);

  // H-3: probe the REAL decoded duration and reject over-limit media BEFORE STT,
  // regardless of the declared `duration`. Account the actual bytes + duration.
  const probe = deps.probeDuration ?? ((m, mime) => probeDurationFromBytes(m, mime, deps.signal));
  let realDurationSec: number | undefined;
  try {
    realDurationSec = await probe(plaintext, descriptor.m);
  } catch (e) {
    // ffprobe never ANSWERED (timed out, was killed, could not be spawned). That is
    // a fact about this host at this moment, not about the media, and the branch
    // below would otherwise cache it as a permanent policy rejection: the recording
    // is never transcribed and re-submitting the identical blob hits the same
    // cached empty transcript forever. Account the bytes we really spent
    // downloading (abuse is metered even on failure) and rethrow so the job runner
    // retries with backoff. Nothing is cached.
    if (e instanceof ProbeUnavailableError) {
      deps.onUsage?.({ bytes: ciphertext.length, durationSec: 0 });
    }
    throw e;
  }
  // Unknown is booked as 0 against the usage budget because there is nothing else
  // to book — which is precisely why an unknown duration must not also be allowed
  // to PASS the cap below (2026-09-04 audit).
  deps.onUsage?.({ bytes: ciphertext.length, durationSec: realDurationSec ?? 0 });
  if (deps.maxDurationSec) {
    // "Could not probe" used to read as 0 seconds and sail through this comparison.
    // ffprobe failing does not mean ffmpeg will: a container whose header ffprobe
    // cannot parse can still be DECODED, so the attacker's move was a media file
    // that defeats the probe — which bypassed the event's duration cap AND booked
    // 0 seconds against the budget meant to bound the spend, while the STT bill for
    // the full-length audio was entirely real. Both halves of H-3's enforcement,
    // undone by one unparseable header.
    //
    // MediaPolicyError (not a throw that poisons the attendee): this rejects THIS
    // media only — an empty transcript is cached, no STT — and processAttendee
    // carries on with the attendee's other media and their authored profile.
    if (realDurationSec === undefined) {
      deps.store.putTranscript(descriptor.x, "", now());
      throw new MediaPolicyError(
        `could not determine the decoded duration (ffprobe gave no usable answer) and a ` +
          `${deps.maxDurationSec}s event limit is enforced — unprobeable media is rejected, not waved through`,
      );
    }
    if (realDurationSec > deps.maxDurationSec) {
      deps.store.putTranscript(descriptor.x, "", now());
      throw new MediaPolicyError(
        `decoded duration ${realDurationSec}s exceeds the ${deps.maxDurationSec}s event limit`,
      );
    }
  }

  const caps = await deps.stt.capabilities();
  const extract =
    deps.extractAudio ?? ((m, mime, maxBytes) => extractAudioSegments(m, mime, maxBytes, deps.signal));
  const segments = await extract(plaintext, descriptor.m, caps.maxUploadBytes);

  const parts: string[] = [];
  let lang: string | undefined;
  for (const seg of segments) {
    deps.signal?.throwIfAborted();
    const { text, language } = await deps.stt.transcribe(
      { data: seg.data, mime: seg.mime },
      { model: deps.sttModel, signal: deps.signal },
    );
    parts.push(text);
    if (!lang && language) lang = language; // first segment that reports a language
  }
  const transcript = parts.join(" ").trim();
  // An EMPTY transcript from audio that plainly had something in it is not cached
  // (2026-09-04 audit). The transcript cache is keyed by blob sha256 and is
  // permanent, so caching "" here spends one provider hiccup to discard an intro
  // the attendee recorded — forever, indistinguishably from silence, and no
  // reprocess can recover it because the cache hit short-circuits before the
  // download. Venice's adapter now refuses an absent `text` outright; this covers
  // the rest of the class (a provider that answers `{"text": ""}`, a segment that
  // came back blank).
  //
  // Genuinely silent or near-empty audio is left cacheable, so a truly blank
  // recording still costs exactly one STT call: the threshold is total EXTRACTED
  // audio bytes, which at the 16 kbit/s mono Opus this pipeline produces is ~2 KB
  // per second.
  const audioBytes = segments.reduce((n, s) => n + s.data.length, 0);
  if (transcript === "" && audioBytes >= MIN_AUDIO_BYTES_TO_EXPECT_SPEECH) {
    console.warn(
      `[stt] empty transcript for ${audioBytes} bytes of extracted audio (blob ${descriptor.x.slice(0, 12)}…) — ` +
        `NOT caching it, so a reprocess can try again rather than inheriting a permanent silence`,
    );
    return { text: transcript, lang };
  }
  deps.store.putTranscript(descriptor.x, transcript, now(), lang);
  return { text: transcript, lang };
}
