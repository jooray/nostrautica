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
import type { AiProfile, AttendeeProfile, MediaDescriptor } from "@nostrautica/protocol";
import type { LlmProvider, SttProvider, ModelRef } from "../providers/types.js";
import type { Store } from "../store/db.js";
import { transcribeMedia } from "./transcribe.js";
import {
  buildAiProfile,
  summarizeNostr,
  nostrInputsHash,
  type NostrPost,
} from "./profile.js";

export interface ProcessDeps {
  store: Store;
  stt: SttProvider;
  sttModel: string;
  llm: LlmProvider;
  summaryModel: ModelRef;
  matchModel: ModelRef;
  fetchBlob?: (urls: string[], sha256: string) => Promise<Uint8Array>;
  /** Override the transcription stage (tests inject to skip real Blossom/ffmpeg). */
  transcribe?: (descriptor: MediaDescriptor) => Promise<string>;
  /** Fetch the attendee's kind-0 + last N public posts (resolved reposts). */
  fetchNostrContext: (pubkey: string, n: number) => Promise<NostrPost[]>;
  nostrContextN: number;
  now?: () => number;
}

export interface ProcessInput {
  pubkey: string;
  profile: AttendeeProfile;
  media: MediaDescriptor[];
}

/** Run the full profile pipeline for one attendee and return their ai_profile. */
export async function processAttendee(
  deps: ProcessDeps,
  input: ProcessInput,
): Promise<AiProfile> {
  const now = deps.now ?? (() => Date.now());

  // 1. Transcribe each media blob (cached by blob sha256).
  const transcribe =
    deps.transcribe ??
    ((descriptor) =>
      transcribeMedia(
        { store: deps.store, stt: deps.stt, sttModel: deps.sttModel, fetchBlob: deps.fetchBlob, now },
        descriptor,
      ));
  const transcripts: string[] = [];
  for (const descriptor of input.media) {
    const text = await transcribe(descriptor);
    if (text) transcripts.push(text);
  }

  // 2. Nostr-context summary (skipped if N=0 or no content), cached by inputs hash.
  let nostrSummary: string | undefined;
  if (deps.nostrContextN > 0) {
    const posts = await deps.fetchNostrContext(input.pubkey, deps.nostrContextN);
    if (posts.length > 0) {
      const inputsHash = nostrInputsHash(input.pubkey, posts);
      const cached = deps.store.getSummary(input.pubkey, inputsHash);
      if (cached !== undefined) {
        nostrSummary = cached;
      } else {
        nostrSummary = await summarizeNostr(deps.llm, deps.summaryModel, input.pubkey, posts);
        if (nostrSummary) deps.store.putSummary(input.pubkey, inputsHash, nostrSummary, now());
      }
    }
  }

  // 3. Build the ai_profile from transcripts + profile + nostr summary.
  return buildAiProfile(deps.llm, deps.matchModel, {
    transcripts,
    profile: input.profile,
    nostrSummary,
  });
}
