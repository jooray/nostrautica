/**
 * Transcription stage (spec §9.2). Fetch the encrypted blob from Blossom, verify
 * + decrypt it, extract mono 16 kHz Opus audio (segmenting to fit the provider's
 * byte limit), transcribe each segment, and concatenate. Cached by blob sha256
 * so a restart never re-pays for a transcript.
 */
import { decryptMedia, sha256Hex, type MediaDescriptor } from "@nostrautica/protocol";
import type { SttProvider } from "../providers/types.js";
import type { Store } from "../store/db.js";
import { extractAudioSegments } from "./audio.js";
import { safeFetch, SafeFetchError } from "../net/safe-fetch.js";

/** Default hard ceiling on a downloaded media blob (audit C3). */
export const DEFAULT_MAX_MEDIA_BYTES = 200 * 1024 * 1024;

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
  const plaintext = await decryptMedia(descriptor, ciphertext);

  const caps = await deps.stt.capabilities();
  const segments = await extractAudioSegments(plaintext, descriptor.m, caps.maxUploadBytes);

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
