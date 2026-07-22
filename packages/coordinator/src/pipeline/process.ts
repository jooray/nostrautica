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
   * STT-detected language.
   */
  transcribe?: (descriptor: MediaDescriptor) => Promise<string | TranscriptResult>;
  /** Blossom origins media may be fetched from (audit C3 allowlist). */
  blossomOrigins?: string[];
  /** Max media bytes per blob download (audit C3). */
  maxMediaBytes?: number;
  /** Real decoded-duration limit for intro media (audit H-3); 0/undefined ⇒ none. */
  maxDurationSec?: number;
  /** Injectable duration probe (tests). */
  probeDuration?: (media: Uint8Array, mime: string) => Promise<number>;
  /** Account actual downloaded bytes + probed duration into the usage budgets (H-2/H-3). */
  onMediaUsage?: (usage: { bytes: number; durationSec: number }) => void;
  /** Fetch the attendee's kind-0 + last N public posts (resolved reposts). */
  fetchNostrContext: (pubkey: string, n: number) => Promise<NostrPost[]>;
  nostrContextN: number;
  /** Event language (ISO 639-1). AI output is written in it; user fields translated into it. */
  lang: string;
  now?: () => number;
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

  // 1. Transcribe each media blob (cached by blob sha256). Text intros carry no
  //    blob, so they never reach this loop — the authored text is appended below.
  const transcribe =
    deps.transcribe ??
    ((descriptor: MediaDescriptor) =>
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
          onUsage: deps.onMediaUsage,
          now,
        },
        descriptor,
      ));
  const transcripts: string[] = []; // text fed into buildAiProfile
  const published: MediaTranscript[] = []; // STT transcripts published on 31603
  for (const descriptor of input.media) {
    // A media-policy rejection (declared-size mismatch / over-duration, audit H-3)
    // rejects THAT media only — an empty transcript is cached, no STT, and the
    // other media/attendee continue — rather than poisoning the whole attendee.
    let r: string | TranscriptResult;
    try {
      r = await transcribe(descriptor);
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
      } else {
        nostrSummary = await summarizeNostr(
          deps.summary.llm,
          deps.summary,
          input.pubkey,
          posts,
          deps.lang,
        );
        if (nostrSummary) deps.store.putSummary(input.pubkey, inputsHash, nostrSummary, now());
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
      aiProfile = await buildAiProfile(deps.match.llm, deps.match, profileInputs);
      deps.store.putArtifact({
        stage: "ai_profile",
        inputsHash: profileKey,
        provider: deps.match.provider,
        model: deps.match.model,
        output: aiProfile,
        now: now(),
      });
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
    translations = (await translateProfileFields(deps.translate.llm, deps.translate, deps.lang, trFields)) ?? null;
    deps.store.putArtifact({
      stage: "translation",
      inputsHash: trKey,
      provider: deps.translate.provider,
      model: deps.translate.model,
      output: translations,
      now: now(),
    });
  }
  if (translations) aiProfile.translations = translations;
  return { aiProfile, transcripts: published };
}
