/**
 * Transcription stage (spec §9.2). Fetch the encrypted blob from Blossom, verify
 * + decrypt it, extract mono 16 kHz Opus audio (segmenting to fit the provider's
 * byte limit), transcribe each segment, and concatenate. Cached by blob sha256
 * so a restart never re-pays for a transcript.
 */
import { decryptMedia, sha256Hex, type MediaDescriptor,
  MAX_MEDIA_FILE_BYTES, base64ToBytes, concatBytes, utf8ToBytes,
} from "@nostrautica/protocol";
import type { SttProvider } from "../providers/types.js";
import type { Store } from "../store/db.js";
import {
  extractAudioSegments,
  probeDurationFromBytes,
  SubprocessError,
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
 * How many empty STT answers a blob gets before it is rejected as media policy
 * (audit DS41-040). Each one before the last is a retryable failure, so the job
 * runner tries again on its backoff schedule (1 s, 10 s, 100 s, then hourly); five
 * attempts span the first hour, long enough to ride out a provider hiccup. After
 * that the recording is treated as one the provider cannot hear, and the attendee's
 * pipeline carries on without it rather than poisoning. An organizer `reprocess`
 * resets the count.
 */
export const MAX_EMPTY_STT_ATTEMPTS = 5;

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

/**
 * STT answered with no text for audio long enough to hold speech (audit DS41-040).
 * Retryable: thrown up to {@link MAX_EMPTY_STT_ATTEMPTS} − 1 times per blob, after
 * which the same condition becomes a {@link MediaPolicyError}.
 */
export class EmptyTranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyTranscriptError";
  }
}

export interface BlobFetchOptions {
  /** Blossom origins the coordinator may fetch from (empty = any public https host). */
  allowedOrigins?: string[];
  maxBytes?: number;
  /** Caller cancellation (audit R13): shutdown / per-event teardown. */
  signal?: AbortSignal;
  /** Every body chunk's size, across every mirror tried and on failure too (audit R-18). */
  onBytes?: (n: number) => void;
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
      const bytes = await get(url, { allowedOrigins: opts.allowedOrigins, maxBytes, signal: opts.signal, onBytes: opts.onBytes });
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
  /**
   * The (event, attendee) this transcription is for (audit C5, R-15/R-16). The
   * ownership ref is recorded only once this caller has PROVEN it holds the key —
   * a fingerprint-matched cache hit, or a successful decrypt — so a claimer who
   * knows nothing but the public ciphertext hash cannot pin someone else's
   * transcript past its owner's purge.
   */
  owner?: { coordinate: string; pubkey: string };
  now?: () => number;
}

/**
 * Fingerprint of the key material a descriptor carries (audit R-16), stored next
 * to a cached transcript so a cache hit requires the key and not just `x`. `x` is
 * the ciphertext hash: it is in the Blossom URL, visible to the Blossom operator
 * and to anyone the blob's link ever reached. Holding it proves nothing; holding
 * a key that decrypts the blob to `ox` does. Hashed over the decoded bytes, so two
 * base64 spellings of one key agree, and domain-separated so it is useless as
 * anything but this cache's lookup key.
 */
export function transcriptKeyFingerprint(descriptor: MediaDescriptor): string {
  return sha256Hex(
    concatBytes(
      utf8ToBytes(`nostrautica/transcript-key/v1|${descriptor.ox}|`),
      base64ToBytes(descriptor["decryption-key"]),
      base64ToBytes(descriptor["decryption-nonce"]),
    ),
  );
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
  const owner = deps.owner;
  const keyFp = transcriptKeyFingerprint(descriptor);
  // Audit R-16. This used to return the cached row on `x` alone, before any
  // download or decrypt: a descriptor naming someone else's blob hash with a
  // garbage key got their plaintext transcript back (and published it on its own
  // 31603), and its ownership ref kept that transcript alive past the owner's
  // purge. A hit now needs the key the transcript was produced under; anything
  // else takes the full path, where a wrong key fails the decrypt below.
  const cached = deps.store.getTranscriptRow(descriptor.x);
  if (cached !== undefined && cached.key_fp === keyFp) {
    if (owner) deps.store.recordTranscriptRef(descriptor.x, owner.coordinate, owner.pubkey, now());
    return { text: cached.text, lang: cached.lang ?? undefined };
  }
  // Already given up on (DS41-040): reject before paying for another download + STT.
  const emptySoFar = deps.store.emptySttAttempts(descriptor.x);
  if (emptySoFar >= MAX_EMPTY_STT_ATTEMPTS) {
    throw new MediaPolicyError(
      `speech-to-text returned nothing for this recording ${emptySoFar} times — rejected (an organizer reprocess retries it)`,
    );
  }

  deps.signal?.throwIfAborted();
  // Audit R-18: every byte streamed is booked, whichever mirror sent it and
  // whether or not the download then succeeded. Only the success path and two
  // rejection branches used to book anything, so a body cut off mid-stream, one
  // run past the cap, or one whose hash did not match cost real transfer that
  // never reached the usage budget. And the cap is the descriptor's own `size`
  // (bounded by the operator's per-blob limit), not the 250 MiB ceiling: `size`
  // is what capMedia screened against the submission budget, so a blob larger
  // than it declared is a policy rejection at `size + 1` bytes, not at 250 MiB.
  let streamed = 0;
  const download =
    deps.fetchBlob ??
    ((urls: string[], sha: string) =>
      fetchBlob(urls, sha, {
        allowedOrigins: deps.blossomOrigins,
        maxBytes: Math.min(deps.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES, descriptor.size),
        signal: deps.signal,
        onBytes: (n) => {
          streamed += n;
        },
      }));
  let ciphertext: Uint8Array;
  try {
    ciphertext = await download(descriptor.url, descriptor.x);
  } catch (e) {
    if (streamed > 0) deps.onUsage?.({ bytes: streamed, durationSec: 0 });
    throw e;
  }
  // Booked once, here, before anything below can reject or return: a decrypt
  // failure and a legacy cache reuse spent the download too. An injected
  // downloader reports no chunks; then the body itself is the measure.
  deps.onUsage?.({ bytes: Math.max(streamed, ciphertext.length), durationSec: 0 });

  // H-3: the actual downloaded ciphertext length MUST equal the declared `size`.
  // A mismatch means the descriptor lied (a declared `size: 1` fronting a huge blob
  // to duck the aggregate byte budget). The bytes are already booked above;
  // reject this media (no decrypt/STT).
  //
  // Not cached (audit R-16). The verdict belongs to THIS descriptor, not to the
  // blob: caching `""` under `x` let anyone who knew a victim's blob hash submit
  // it with a wrong `size` and silence the victim's transcript for good, since
  // the cache hit short-circuited everything after it. A repeat costs a metered
  // download, and the job runner never retries a MediaPolicyError.
  if (ciphertext.length !== descriptor.size) {
    throw new MediaPolicyError(
      `declared size ${descriptor.size} != actual ciphertext length ${ciphertext.length}`,
    );
  }

  // Deterministic failures reject THIS media, not the attendee (audit DS41-037).
  // The ciphertext's hash was already verified by the download, so a decrypt that
  // fails (GCM tag, `ox` mismatch) will fail identically on every retry; thrown as
  // a plain Error it rode the 3-day retry tail, re-downloading each time, and then
  // poisoned the attendee's whole pipeline over one bad recording. Not cached: the
  // key lives in the descriptor, not the blob.
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptMedia(descriptor, ciphertext);
  } catch (e) {
    throw new MediaPolicyError(`media does not decrypt with its descriptor: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The key is now proven. A row written by an older binary carries no
  // fingerprint, so it could not be served above; bind it to this key and serve
  // it without paying for STT again. Except an EMPTY one: that is exactly what
  // the old size-mismatch branch planted, and re-transcribing a silent clip once
  // is cheap.
  if (cached !== undefined && cached.text !== "") {
    deps.store.setTranscriptKeyFp(descriptor.x, keyFp);
    if (owner) deps.store.recordTranscriptRef(descriptor.x, owner.coordinate, owner.pubkey, now());
    return { text: cached.text, lang: cached.lang ?? undefined };
  }

  // H-3: probe the REAL decoded duration and reject over-limit media BEFORE STT,
  // regardless of the declared `duration`. Account the actual bytes + duration.
  const probe = deps.probeDuration ?? ((m, mime) => probeDurationFromBytes(m, mime, deps.signal));
  // A probe that never ANSWERED (ProbeUnavailableError: timed out, was killed,
  // could not be spawned) is a fact about this host at this moment, not about the
  // media, and the branch below would otherwise cache it as a permanent policy
  // rejection: the recording is never transcribed and re-submitting the identical
  // blob hits the same cached empty transcript forever. The bytes are already
  // booked; it propagates so the job runner retries with backoff. Nothing is cached.
  const realDurationSec: number | undefined = await probe(plaintext, descriptor.m);
  // Unknown is booked as 0 against the usage budget because there is nothing else
  // to book — which is precisely why an unknown duration must not also be allowed
  // to PASS the cap below (2026-09-04 audit).
  deps.onUsage?.({ bytes: 0, durationSec: realDurationSec ?? 0 });
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
    // media only — no STT — and processAttendee carries on with the attendee's
    // other media and their authored profile.
    //
    // NEITHER branch caches (audit B-7). The transcript cache is keyed by blob
    // sha256 ALONE and is shared across every event this coordinator serves, but
    // both of these verdicts depend on THIS event's limit: the same blob is a
    // rejection under a 90s intro cap and perfectly fine under a 900s one. Caching
    // `""` here meant the strict event poisoned the lenient one — an attendee
    // reusing one intro at two events (the reuse flow the product advertises) got
    // silence at the second, with `stt.calls` never incremented and no way to tell
    // it from a genuinely silent recording. (The declared-size check above no
    // longer caches either, audit R-16.) The cost of not caching is one repeat
    // download+probe per processing attempt, and those bytes are metered
    // (`onUsage`, just above) exactly as an accepted blob's are.
    if (realDurationSec === undefined) {
      throw new MediaPolicyError(
        `could not determine the decoded duration (ffprobe gave no usable answer) and a ` +
          `${deps.maxDurationSec}s event limit is enforced — unprobeable media is rejected, not waved through`,
      );
    }
    if (realDurationSec > deps.maxDurationSec) {
      throw new MediaPolicyError(
        `decoded duration ${realDurationSec}s exceeds the ${deps.maxDurationSec}s event limit`,
      );
    }
  }

  const caps = await deps.stt.capabilities();
  const extract =
    deps.extractAudio ??
    ((m, mime, maxBytes) => extractAudioSegments(m, mime, maxBytes, deps.signal, deps.maxDurationSec));
  let segments: AudioSegment[];
  try {
    segments = await extract(plaintext, descriptor.m, caps.maxUploadBytes);
  } catch (e) {
    // ffmpeg ran and refused the input (non-zero exit, or output past the cap):
    // the same bytes will be refused again (DS41-037). A timeout or a failed spawn
    // is about this host, not the media, and stays retryable.
    if (e instanceof SubprocessError && (e.kind === "exit" || e.kind === "output")) {
      throw new MediaPolicyError(`audio extraction failed on this media: ${e.message}`);
    }
    throw e;
  }

  // Audit R-17. The probe above reads `format=duration`, which is container
  // METADATA the attendee authored: an MP4 whose header says 30 s and whose
  // samples run for two hours passed a 90 s cap, booked 30 s, and paid STT for two
  // hours. What reaches STT is the Ogg our own ffmpeg just wrote, decoding no more
  // than one second past the limit, and that is measured here. Over-length media
  // measures over the limit and is rejected before the provider is called. Half a
  // second of tolerance absorbs Opus pre-skip, so a clean 90 s recording that
  // reads 90.0065 s still passes. The usage budget is topped up to the measured
  // figure, so the books carry the larger of what the container claimed and what
  // was really decoded.
  const measured = segments.every((seg) => typeof seg.durationSec === "number")
    ? segments.reduce((n, seg) => n + seg.durationSec!, 0)
    : undefined;
  if (measured !== undefined) {
    const extra = Math.round(measured) - (realDurationSec ?? 0);
    if (extra > 0) deps.onUsage?.({ bytes: 0, durationSec: extra });
    if (deps.maxDurationSec && measured > deps.maxDurationSec + 0.5) {
      throw new MediaPolicyError(
        `decoded audio runs past the ${deps.maxDurationSec}s event limit (the container claimed ${realDurationSec ?? "?"}s)`,
      );
    }
  }

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
  //
  // Nor is it a success (audit DS41-040). Returning "" committed the job as done:
  // the attendee got a content-free profile, their pairs were cleared, no status
  // was raised, and a re-delivery hit the terminal dedupe key. It is now a bounded
  // retry — retryable until MAX_EMPTY_STT_ATTEMPTS, then a MediaPolicyError that
  // drops this one recording and lets the rest of the pipeline run.
  if (transcript === "" && audioBytes >= MIN_AUDIO_BYTES_TO_EXPECT_SPEECH) {
    const attempts = deps.store.recordEmptyStt(descriptor.x, now());
    console.warn(
      `[stt] empty transcript for ${audioBytes} bytes of extracted audio (blob ${descriptor.x.slice(0, 12)}…), ` +
        `attempt ${attempts}/${MAX_EMPTY_STT_ATTEMPTS} — not cached`,
    );
    if (attempts >= MAX_EMPTY_STT_ATTEMPTS) {
      throw new MediaPolicyError(
        `speech-to-text returned nothing for ${audioBytes} bytes of audio ${attempts} times — rejected`,
      );
    }
    throw new EmptyTranscriptError(
      `speech-to-text returned nothing for ${audioBytes} bytes of audio (attempt ${attempts}/${MAX_EMPTY_STT_ATTEMPTS}) — retrying`,
    );
  }
  deps.store.putTranscript(descriptor.x, transcript, now(), lang, owner, keyFp);
  return { text: transcript, lang };
}
