/**
 * Transcription stage (spec §9.2). Fetch the encrypted blob from Blossom, verify
 * + decrypt it, extract mono 16 kHz Opus audio (segmenting to fit the provider's
 * byte limit), transcribe each segment, and concatenate. Cached by blob sha256
 * so a restart never re-pays for a transcript.
 */
import { decryptMedia, sha256Hex, type MediaDescriptor } from "@nostrautica/protocol";
import type { SttProvider } from "../providers/types.js";
import type { Store } from "../store/db.js";
import { extractAudioSegments, probeDurationFromBytes, type AudioSegment } from "./audio.js";
import { safeFetch, SafeFetchError } from "../net/safe-fetch.js";

/** Default hard ceiling on a downloaded media blob (audit C3). */
export const DEFAULT_MAX_MEDIA_BYTES = 200 * 1024 * 1024;

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
  let lastErr: unknown;
  for (const url of urls) {
    try {
      const bytes = await safeFetch(url, { allowedOrigins: opts.allowedOrigins, maxBytes });
      if (sha256Hex(bytes) !== expectedSha256) {
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
    }
  }
  throw new Error(`could not fetch blob ${expectedSha256}: ${lastErr}`);
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
  /** Injectable duration probe (tests); defaults to ffprobe on the decrypted bytes. */
  probeDuration?: (media: Uint8Array, mime: string) => Promise<number>;
  /** Injectable audio extraction (tests); defaults to the real ffmpeg pipeline. */
  extractAudio?: (media: Uint8Array, mime: string, maxBytes: number) => Promise<AudioSegment[]>;
  /**
   * Account the ACTUAL downloaded bytes + probed duration into the usage budgets
   * (audit H-2/H-3): declared values are never trusted for accounting. Called even
   * when the media is rejected (bytes were still spent downloading).
   */
  onUsage?: (usage: { bytes: number; durationSec: number }) => void;
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

  const download =
    deps.fetchBlob ??
    ((urls: string[], sha: string) =>
      fetchBlob(urls, sha, { allowedOrigins: deps.blossomOrigins, maxBytes: deps.maxMediaBytes }));
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
  const probe = deps.probeDuration ?? probeDurationFromBytes;
  const realDurationSec = await probe(plaintext, descriptor.m);
  deps.onUsage?.({ bytes: ciphertext.length, durationSec: realDurationSec });
  if (deps.maxDurationSec && realDurationSec > deps.maxDurationSec) {
    deps.store.putTranscript(descriptor.x, "", now());
    throw new MediaPolicyError(
      `decoded duration ${realDurationSec}s exceeds the ${deps.maxDurationSec}s event limit`,
    );
  }

  const caps = await deps.stt.capabilities();
  const extract = deps.extractAudio ?? extractAudioSegments;
  const segments = await extract(plaintext, descriptor.m, caps.maxUploadBytes);

  const parts: string[] = [];
  let lang: string | undefined;
  for (const seg of segments) {
    const { text, language } = await deps.stt.transcribe(
      { data: seg.data, mime: seg.mime },
      { model: deps.sttModel },
    );
    parts.push(text);
    if (!lang && language) lang = language; // first segment that reports a language
  }
  const transcript = parts.join(" ").trim();
  deps.store.putTranscript(descriptor.x, transcript, now(), lang);
  return { text: transcript, lang };
}
