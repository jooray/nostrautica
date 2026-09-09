/**
 * Per-attendee processing composition (spec §9.2). Given an attendee's submitted
 * profile + media and their public Nostr activity, produce an ai_profile:
 *
 *   media → transcript(s)  (cached by blob sha256)
 *   pubkey + last N posts → nostr summary  (cached by inputs hash; skipped if N=0)
 *   transcripts + profile + summary → ai_profile  (matchModel, strict JSON)
 *
 * Blob and Nostr-context fetching are injected so this is unit-testable with
 * fixtures and mock providers.
 */
import type { AiProfile, AttendeeProfile, MediaDescriptor, MediaTranscript } from "@nostrautica/protocol";
import type { SttProvider, RoleRoute } from "../providers/types.js";
import { ProviderContractError } from "../providers/types.js";
import { ProviderHttpError } from "../providers/http.js";
import type { Store } from "../store/db.js";
import { transcribeMedia, MediaPolicyError, type TranscriptResult } from "./transcribe.js";
import {
  buildAiProfile,
  summarizeNostr,
  nostrInputsHash,
  profileInputsHash,
  translationInputsHash,
  translateProfileFields,
  type NostrPost,
} from "./profile.js";
import type { AiProfile as AiProfileType } from "@nostrautica/protocol";

export interface ProcessDeps {
  store: Store;
  stt: SttProvider;
  sttModel: string;
  /** Per-role provider routes (audit H-1): each stage runs on its OWN resolved
   *  provider instance + model, not a single global LLM. */
  summary: RoleRoute;
  match: RoleRoute;
  translate: RoleRoute;
  fetchBlob?: (urls: string[], sha256: string) => Promise<Uint8Array>;
  /**
   * Override the transcription stage (tests inject to skip real Blossom/ffmpeg).
   * May return a bare string (text only) or a {@link TranscriptResult} carrying the
   * STT-detected language. Receives the caller cancellation signal (audit R13) so an
   * injected/alternative implementation can honor shutdown / per-event teardown too.
   */
  transcribe?: (descriptor: MediaDescriptor, signal?: AbortSignal) => Promise<string | TranscriptResult>;
  /** Blossom origins media may be fetched from (audit C3 allowlist). */
  blossomOrigins?: string[];
  /** Max media bytes per blob download (audit C3). */
  maxMediaBytes?: number;
  /** Real decoded-duration limit for intro media (audit H-3); 0/undefined ⇒ none. */
  maxDurationSec?: number;
  /** Injectable duration probe (tests). `undefined` = "could not probe" (audit H-3). */
  probeDuration?: (media: Uint8Array, mime: string) => Promise<number | undefined>;
  /** Injectable audio extraction (tests), so the STT boundary is reachable without
   *  a real ffmpeg. Same seam as `probeDuration`, and it is what lets a test observe
   *  whether cancellation reaches the transcriber at all (audit SEC-18/R13). */
  extractAudio?: (
    media: Uint8Array,
    mime: string,
    maxBytes: number,
  ) => Promise<{ data: Uint8Array; mime: string }[]>;
  /** Account actual downloaded bytes + probed duration into the usage budgets (H-2/H-3). */
  onMediaUsage?: (usage: { bytes: number; durationSec: number }) => void;
  /** Fetch the attendee's kind-0 + last N public posts (resolved reposts). */
  fetchNostrContext: (pubkey: string, n: number) => Promise<NostrPost[]>;
  nostrContextN: number;
  /** Event language (ISO 639-1). AI output is written in it; user fields translated into it. */
  lang: string;
  /** The event coordinate — records ownership references for the derived artifacts so
   *  a reference-counted deletion (audit C5) can drop this subject's data without
   *  harming another event that shares a deduplicated transcript/artifact/summary. */
  coordinate?: string;
  /** Shutdown cancellation (audit C11): checked at each stage boundary so a long
   *  STT/LLM run unwinds promptly when the coordinator is shutting down. */
  signal?: AbortSignal;
  now?: () => number;
  /** Operator log. Optional so tests can stay silent; the daemon always passes it —
   *  a stage that degrades instead of failing must still leave a trace, or the
   *  degradation is invisible until someone reads the database. */
  log?: (msg: string) => void;
  /**
   * "This stage degraded on a failure that could plausibly succeed later — queue
   * the work again."
   *
   * Degrading a stage instead of failing the job (translation, and now the nostr
   * summary) keeps the attendee's profile, directory entry and matches, which is
   * the right trade. But until now that was ALL it did: the failed artifact is
   * deliberately not cached, and nothing re-ran it, so a transient provider blip
   * left the profile permanently untranslated — recovered only if the attendee
   * happened to edit their profile, which most never do. There was a log line and
   * no other consequence.
   *
   * The job runner is the mechanism (backoff, attempt cap, poison), and this hook
   * is how a stage that has already decided to degrade asks for one. Injected
   * rather than called directly so this module keeps knowing nothing about jobs,
   * and so a test can assert the request without a runner.
   *
   * Only called for a plausibly-TRANSIENT failure: a `ProviderContractError` is
   * deterministic for a given prompt and model, so re-queueing it only re-bills
   * (the lesson of the 27-attempt translation poison in July).
   */
  retryLater?: (req: {
    stage: "translation" | "nostr_summary";
    pubkey: string;
    reason: string;
    /**
     * How long to wait before the retry runs. A degraded stage is asked for again
     * because the world was briefly wrong — a 429, a 5xx, a dropped socket — and
     * the retry used to be enqueued runnable IMMEDIATELY, which hits a
     * rate-limited provider again in the same second and burns the one retry the
     * dedupe key allows. Honours the provider's own `Retry-After` when it sent
     * one, and otherwise waits long enough for a blip to have passed.
     */
    delayMs: number;
  }) => void;
}

export interface ProcessInput {
  pubkey: string;
  profile: AttendeeProfile;
  media: MediaDescriptor[];
  /** A plain-text intro (spec F1). Feeds the ai_profile directly — no STT. */
  introText?: string;
  /**
   * Extra transcript texts folded into the ai_profile (spec §9.2, F2): a speaker's
   * prerecorded-talk transcripts, so a talk contributes to matching "as today".
   * Already transcribed (by process_talk) — no STT here, no MediaTranscript published.
   */
  extraTranscripts?: string[];
}

/** The ai_profile plus the transcripts to publish on the directory entry (F1). */
export interface ProcessResult {
  aiProfile: AiProfile;
  /** One per STT-transcribed media blob, tied to the blob by `x` (audit A1). */
  transcripts: MediaTranscript[];
  /**
   * Optional stages that failed and were skipped, with the reason. Present so a
   * caller that would rather read a return value than take the {@link
   * ProcessDeps.retryLater} callback can see what degraded — and so a test can
   * assert it. `retryable` is false for a deterministic provider-contract failure,
   * where asking again only re-bills the same wrong answer.
   */
  degraded?: { stage: "translation" | "nostr_summary"; reason: string; retryable: boolean }[];
}

/**
 * Is re-running this stage later worth the money?
 *
 * A {@link ProviderContractError} means the model answered in a shape we cannot
 * use. That is a property of (prompt, model), not of the moment: the July
 * translation poison spent 27 fully-billed attempts on a response shape that could
 * never pass. Everything else — a timeout, a 5xx, a depleted balance, a dropped
 * socket — is about the world at that instant and is worth asking again.
 */
function isRetryableStageFailure(e: unknown): boolean {
  return !(e instanceof ProviderContractError);
}

/** Default wait before a degraded stage is re-attempted, when the provider gave no
 *  `Retry-After`. Long enough that a rate limit or a restarting backend has moved
 *  on, short enough that a profile is translated well within the event. */
const DEFAULT_STAGE_RETRY_MS = 60_000;

/** How long to wait before re-running a degraded stage that failed with `e`. */
function stageRetryDelayMs(e: unknown): number {
  const after = e instanceof ProviderHttpError ? e.retryAfterSec : undefined;
  return after !== undefined ? Math.max(after * 1000, 1_000) : DEFAULT_STAGE_RETRY_MS;
}

/** Run the full profile pipeline for one attendee (spec §9.2, F1 branch).
 *
 * Three intro shapes converge here:
 *  - video → today's path: fetch blob → ffmpeg-extract audio → STT → transcript.
 *  - audio → same downloader/STT (ffmpeg normalizes any mime; no video decode).
 *  - text  → `introText` IS the transcript; STT is skipped entirely.
 * All three feed `buildAiProfile`, so a text-only attendee (media:[]) still gets
 * an ai_profile. STT-derived transcripts are also returned for publication.
 */
export async function processAttendee(
  deps: ProcessDeps,
  input: ProcessInput,
): Promise<ProcessResult> {
  const now = deps.now ?? (() => Date.now());
  const degraded: NonNullable<ProcessResult["degraded"]> = [];

  // 1. Transcribe each media blob (cached by blob sha256). Text intros carry no
  //    blob, so they never reach this loop — the authored text is appended below.
  const transcribe =
    deps.transcribe ??
    ((descriptor: MediaDescriptor, sig?: AbortSignal) =>
      transcribeMedia(
        {
          store: deps.store,
          stt: deps.stt,
          sttModel: deps.sttModel,
          fetchBlob: deps.fetchBlob,
          blossomOrigins: deps.blossomOrigins,
          maxMediaBytes: deps.maxMediaBytes,
          maxDurationSec: deps.maxDurationSec,
          probeDuration: deps.probeDuration,
          extractAudio: deps.extractAudio,
          onUsage: deps.onMediaUsage,
          // Cancellation, forwarded (audit R13/SEC-18). The parameter was accepted
          // and dropped here, so an abort could only be observed BETWEEN media —
          // never inside the blob download, the ffprobe, or the STT call, which is
          // where all the waiting happens. The talk path already forwards it; this
          // is the intro path, the same fix on the other side.
          signal: sig,
          now,
        },
        descriptor,
      ));
  const owner = deps.coordinate ? { coordinate: deps.coordinate, pubkey: input.pubkey } : undefined;
  const transcripts: string[] = []; // text fed into buildAiProfile
  const published: MediaTranscript[] = []; // STT transcripts published on 31603
  for (const descriptor of input.media) {
    deps.signal?.throwIfAborted(); // shutdown cancellation (audit C11/R13)
    // Ownership reference for the content-addressed transcript (audit C5): record it
    // for THIS subject regardless of the transcription outcome (the payload — full or
    // empty-on-policy-rejection — is content-addressed by `x`), so a purge can
    // reference-count it.
    if (owner) deps.store.recordTranscriptRef(descriptor.x, owner.coordinate, owner.pubkey, now());
    // A media-policy rejection (declared-size mismatch / over-duration, audit H-3)
    // rejects THAT media only — an empty transcript is cached, no STT, and the
    // other media/attendee continue — rather than poisoning the whole attendee.
    let r: string | TranscriptResult;
    try {
      r = await transcribe(descriptor, deps.signal);
    } catch (e) {
      if (e instanceof MediaPolicyError) continue;
      throw e;
    }
    const text = typeof r === "string" ? r : r.text;
    const detected = typeof r === "string" ? undefined : r.lang;
    if (text) {
      transcripts.push(text);
      published.push({
        x: descriptor.x,
        text,
        lang: detected ?? (deps.lang || "en").toLowerCase(),
        source: "stt",
        updated_at: now(),
      });
    }
  }
  // A text intro is its own transcript (source "authored"): fed to the profile
  // model like an STT transcript, but surfaced to readers via `intro_text` (it has
  // no media blob, so it is not a MediaTranscript on the entry).
  const introText = input.introText?.trim();
  if (introText) transcripts.push(introText);
  // Talk transcripts (spec §9.2, F2): fed into the profile model like an intro
  // transcript so a speaker's talks contribute to matching. Not published as
  // MediaTranscripts here — they live on the talk's own 31610 entry.
  for (const extra of input.extraTranscripts ?? []) {
    const t = extra.trim();
    if (t) transcripts.push(t);
  }

  // 2. Nostr-context summary (skipped if N=0 or no content), cached by inputs hash
  //    (the hash includes the output language, so a lang change re-summarizes).
  deps.signal?.throwIfAborted(); // shutdown cancellation (audit C11)
  let nostrSummary: string | undefined;
  if (deps.nostrContextN > 0) {
    const posts = await deps.fetchNostrContext(input.pubkey, deps.nostrContextN);
    if (posts.length > 0) {
      // Include the summary provider/model in the cache key (audit H-1): a role
      // rerouted to a different provider/model must not reuse the old summary.
      const summaryModelKey = `${deps.summary.provider}:${deps.summary.model}`;
      const inputsHash = nostrInputsHash(input.pubkey, posts, deps.lang, summaryModelKey);
      const cached = deps.store.getSummary(input.pubkey, inputsHash);
      if (cached !== undefined) {
        nostrSummary = cached;
        // Cache hit (audit R11): record this event's ownership of the shared
        // per-account summary so a purge reference-counts it correctly.
        if (owner) deps.store.recordSummaryRef(input.pubkey, inputsHash, owner.coordinate, now());
      } else {
        // The nostr summary is ENRICHMENT, and until now it could take the whole
        // attendee down with it. `nostrSummaryResponseSchema` is `{summary: string}`,
        // so a `{"summary": null}` — the same malformation that cost three
        // attendees their translations in July, from the same model family — threw a
        // ProviderContractError that unwound ALL of processAttendee. The attendee
        // lost their ai_profile, their directory entry and every match they would
        // have had, over an optional paragraph summarizing their public posts.
        //
        // Same shape as the translation stage below: log, continue without it, and
        // do NOT cache the failure (putSummary only ever records a real answer, so a
        // cache hit always means "asked and answered"). A transient failure asks the
        // job runner for another go; a deterministic one does not, because it would
        // only re-bill the identical wrong answer.
        try {
          nostrSummary = await summarizeNostr(
            deps.summary.llm,
            deps.summary,
            input.pubkey,
            posts,
            deps.lang,
            deps.signal,
          );
          if (nostrSummary)
            deps.store.putSummary(input.pubkey, inputsHash, nostrSummary, now(), owner ? { coordinate: owner.coordinate } : undefined);
        } catch (e) {
          // Shutdown still wins — an aborted run must unwind, not quietly continue
          // and commit against a store the shutdown is about to close (audit C11).
          if (deps.signal?.aborted) throw e;
          nostrSummary = undefined;
          const reason = e instanceof Error ? e.message : String(e);
          const retryable = isRetryableStageFailure(e);
          degraded.push({ stage: "nostr_summary", reason, retryable });
          deps.log?.(
            `[pipeline] ${input.pubkey.slice(0, 8)}: nostr summary failed, building the profile without it — ${reason}`,
          );
          if (retryable)
            deps.retryLater?.({ stage: "nostr_summary", pubkey: input.pubkey, reason, delayMs: stageRetryDelayMs(e) });
        }
      }
    }
  }

  // 3. Build the ai_profile from transcripts + profile + nostr summary (in the
  //    event language), content-addressed (audit H7): a crash between generating the
  //    profile and publishing/translating it never re-bills the model — the finished
  //    artifact is looked up by its stage + canonical-input hash on retry.
  //    Empty-input skip (audit COORD-4): with NO inputs at all (no profile fields,
  //    no transcripts, no nostr summary) don't pay for a model call that could only
  //    confabulate — publish the empty profile instead.
  const profileEmpty =
    !input.profile.about.trim() &&
    input.profile.skills.length === 0 &&
    !input.profile.looking_for.trim() &&
    input.profile.links.length === 0;
  let aiProfile: AiProfileType | undefined;
  if (profileEmpty && transcripts.length === 0 && !nostrSummary) {
    aiProfile = { summary: "", skills: [], interests: [], offers: [], seeks: [] };
  } else {
    const profileInputs = { transcripts, profile: input.profile, nostrSummary, lang: deps.lang };
    const profileModelKey = `${deps.match.provider}:${deps.match.model}`;
    const profileKey = profileInputsHash(profileInputs, profileModelKey);
    aiProfile = deps.store.getArtifact("ai_profile", profileKey) as AiProfileType | undefined;
    if (!aiProfile) {
      deps.signal?.throwIfAborted(); // shutdown cancellation (audit C11)
      aiProfile = await buildAiProfile(deps.match.llm, deps.match, profileInputs, deps.signal);
      deps.store.putArtifact({
        stage: "ai_profile",
        inputsHash: profileKey,
        provider: deps.match.provider,
        model: deps.match.model,
        output: aiProfile,
        now: now(),
        owner,
      });
    } else if (owner) {
      // Cache hit (audit R11): this event is now an owner of the shared artifact —
      // record the ref so a purge reference-counts it (and clear any legacy
      // quarantine) instead of the second event freeloading without attribution.
      deps.store.recordArtifactRef("ai_profile", profileKey, owner, now());
    }
  }

  // 4. If the user's authored fields aren't already in the event language, publish
  //    a translation alongside (never mutating the originals). Independently
  //    content-addressed (audit H7) so a re-run reuses it; a cached `null` records
  //    "already in the target language, nothing to translate".
  const trFields = {
    about: input.profile.about,
    looking_for: input.profile.looking_for,
    skills: input.profile.skills,
  };
  const trModelKey = `${deps.translate.provider}:${deps.translate.model}`;
  const trKey = translationInputsHash(trFields, deps.lang, trModelKey);
  let translations = deps.store.getArtifact("translation", trKey) as AiProfileType["translations"] | null | undefined;
  if (translations === undefined) {
    deps.signal?.throwIfAborted(); // shutdown cancellation (audit C11/R13)
    // A failed translation must NOT fail the job (production incident
    // 2026-07-29). The translation is a decoration on the directory entry — the
    // author's own words are published either way — but a throw here unwound the
    // whole of processAttendee, so nothing reached commitAiProfile and the
    // attendee lost artifacts that had already succeeded: a good ai_profile, and
    // a transcript of an intro they recorded for the event. One attendee sat like
    // that for a day (poisoned after 27 attempts on a provider contract error
    // that could never succeed), their published entry showing no AI summary at
    // all — the Q10 freshness guard correctly omits an ai_profile derived from a
    // superseded revision — and their matches still scored off the profile they
    // had before the submission landed.
    //
    // Deliberately NOT cached on failure: putArtifact only records a real answer,
    // so a `null` in the cache always means "asked, nothing to translate" and
    // never "the call broke once". A later reprocess retries instead of inheriting
    // a permanent no-translation verdict.
    try {
      translations = (await translateProfileFields(deps.translate.llm, deps.translate, deps.lang, trFields, deps.signal)) ?? null;
      deps.store.putArtifact({
        stage: "translation",
        inputsHash: trKey,
        provider: deps.translate.provider,
        model: deps.translate.model,
        output: translations,
        now: now(),
        owner,
      });
    } catch (e) {
      // Shutdown still wins — an aborted run must unwind, not quietly continue
      // and commit against a store the shutdown is about to close (audit C11).
      if (deps.signal?.aborted) throw e;
      translations = null;
      const reason = e instanceof Error ? e.message : String(e);
      const retryable = isRetryableStageFailure(e);
      degraded.push({ stage: "translation", reason, retryable });
      deps.log?.(
        `[pipeline] ${input.pubkey.slice(0, 8)}: translation failed, publishing without it — ${reason}`,
      );
      // Not caching the failure was only HALF the fix (2026-09-04 audit). Nothing
      // re-ran the stage either, so the uncached retry only ever happened if the
      // attendee edited their profile — which most never do. The profile stayed
      // untranslated for the life of the event, and the sole trace was the line
      // above. Ask the job runner for another attempt, unless the failure is the
      // deterministic kind that re-billing cannot fix.
      if (retryable)
        deps.retryLater?.({ stage: "translation", pubkey: input.pubkey, reason, delayMs: stageRetryDelayMs(e) });
    }
  } else if (owner) {
    // Cache hit — a cached `null` (nothing to translate) is still a hit; record this
    // event's ownership ref (audit R11) so purge reference-counts the translation.
    deps.store.recordArtifactRef("translation", trKey, owner, now());
  }
  if (translations) aiProfile.translations = translations;
  return { aiProfile, transcripts: published, ...(degraded.length ? { degraded } : {}) };
}
