/**
 * AI profile building (spec §9.2). Combines the intro/talk transcript(s), the
 * attendee's submitted profile text, and a summary of their public Nostr activity
 * into a strict-JSON ai_profile {summary, skills, interests, offers, seeks}.
 *
 * Every step is cached by an input hash so a restart never re-bills.
 */
import { z } from "zod";
import {
  sha256Hex,
  utf8ToBytes,
  languageName,
  aiProfileSchema,
  type AiProfile,
  type AttendeeProfile,
} from "@nostrautica/protocol";
import type { LlmProvider, ModelRef } from "../providers/types.js";

// ── Provider-output response schemas (audit finding Q9) ──────────────────────
// The model's raw JSON is validated at the provider boundary before it can enter
// storage or publication. The AI profile reuses the shared protocol schema; the
// translation/summary responses have their own local shapes.

/** The AI never emits `translations` itself (the caller adds it), so validate the
 *  core fields with the shared schema — extra keys are stripped, missing/wrong
 *  types throw a ProviderContractError → retry/poison. */
const aiProfileResponseSchema = aiProfileSchema;

const translationResponseSchema = z.object({
  source_lang: z.string(),
  needs_translation: z.boolean(),
  about: z.string().optional(),
  looking_for: z.string().optional(),
  skills: z.array(z.string()).optional(),
});

const nostrSummaryResponseSchema = z.object({ summary: z.string() });

export const AI_PROFILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "skills", "interests", "offers", "seeks"],
  properties: {
    summary: { type: "string", description: "2-3 sentence portrait of this person" },
    skills: { type: "array", items: { type: "string" } },
    interests: { type: "array", items: { type: "string" } },
    offers: { type: "array", items: { type: "string" }, description: "what they can give others" },
    seeks: { type: "array", items: { type: "string" }, description: "what they're looking for" },
  },
} as const;

const PROFILE_SYSTEM = [
  "You build a concise networking profile of a conference attendee from their intro",
  "video transcript, self-described profile, and a summary of their public posts.",
  "Extract concrete skills, interests, what they can OFFER others, and what they SEEK.",
  "Be specific and grounded in the inputs; do not invent. Return strict JSON.",
].join(" ");

/**
 * Output-language instruction for the profile summary (attendee-facing, spec §9.3).
 * The self-described profile and transcripts may be in any language; the summary
 * is written in the event language regardless. Empty for English events.
 */
export function profileLanguageInstruction(lang: string): string {
  const base = (lang || "en").toLowerCase();
  if (base === "en") return "";
  const name = languageName(base);
  return (
    ` The inputs may be in any language. Regardless of the input language, write the` +
    ` "summary" field in ${name} (${base}); keep skills/interests/offers/seeks as concise` +
    ` ${name} terms too.`
  );
}

export interface ProfileInputs {
  transcripts: string[];
  profile: AttendeeProfile;
  nostrSummary?: string;
  /** Event language (ISO 639-1); the summary is written in it. Default "en". */
  lang?: string;
}

/**
 * Deterministic hash of all profile inputs plus the provider/model/language that
 * produce the artifact (audit H7). Any material change — transcript, authored
 * profile, nostr summary, event language, or the model doing the work — yields a
 * new key, so a rerun with identical inputs reuses the cached artifact (no rebill)
 * while a changed input always recomputes.
 */
export function profileInputsHash(inputs: ProfileInputs, modelKey = ""): string {
  const canonical = JSON.stringify({
    t: inputs.transcripts,
    p: inputs.profile,
    n: inputs.nostrSummary ?? "",
    lang: (inputs.lang ?? "en").toLowerCase(),
    m: modelKey,
    schema: "ai_profile.v1",
  });
  return sha256Hex(utf8ToBytes(canonical));
}

/** Deterministic hash for the translation artifact (audit H7). */
export function translationInputsHash(fields: TranslationInput, targetLang: string, modelKey = ""): string {
  const canonical = JSON.stringify({
    about: fields.about,
    looking_for: fields.looking_for,
    skills: fields.skills,
    lang: (targetLang || "en").toLowerCase(),
    m: modelKey,
    schema: "profile_translation.v1",
  });
  return sha256Hex(utf8ToBytes(canonical));
}

export async function buildAiProfile(
  llm: LlmProvider,
  matchModel: ModelRef,
  inputs: ProfileInputs,
): Promise<AiProfile> {
  const user = [
    inputs.transcripts.length ? `INTRO/TALK TRANSCRIPT:\n${inputs.transcripts.join("\n---\n")}` : "",
    `SELF-DESCRIBED PROFILE:\nAbout: ${inputs.profile.about}\nSkills: ${inputs.profile.skills.join(", ")}\nLooking for: ${inputs.profile.looking_for}`,
    inputs.nostrSummary ? `PUBLIC NOSTR ACTIVITY:\n${inputs.nostrSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const { value } = await llm.completeStructured<AiProfile>({
    system: PROFILE_SYSTEM + profileLanguageInstruction(inputs.lang ?? "en"),
    user,
    schema: AI_PROFILE_SCHEMA,
    schemaName: "ai_profile",
    model: matchModel.model,
    temperature: 0.2,
    validate: (raw) => aiProfileResponseSchema.parse(raw),
  });
  return value;
}

// ── User-field translation (spec §7.1, §9.3) ─────────────────────────────────
// User-AUTHORED directory fields (about, looking_for, skills) are shown verbatim
// to attendees. When their language differs from the event language, the
// coordinator additionally publishes a translation so a same-language audience
// can read them — the ORIGINAL fields are never modified. A single call both
// detects the source language and, only if it differs, returns the translation.

export const PROFILE_TRANSLATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["source_lang", "needs_translation"],
  properties: {
    source_lang: {
      type: "string",
      description: "ISO 639-1 code of the language the user's fields are written in",
    },
    needs_translation: {
      type: "boolean",
      description: "true only if source_lang differs from the target event language",
    },
    about: { type: "string", description: "the About text translated into the target language" },
    looking_for: { type: "string", description: "Looking-for text translated into the target language" },
    skills: {
      type: "array",
      items: { type: "string" },
      description: "skills translated into the target language",
    },
  },
} as const;

interface RawTranslation {
  source_lang?: string;
  needs_translation?: boolean;
  about?: string;
  looking_for?: string;
  skills?: string[];
}

export interface TranslationInput {
  about: string;
  looking_for: string;
  skills: string[];
}

/**
 * Detect the source language of the user's authored fields and, if it differs
 * from `targetLang`, translate them. Returns undefined when the source already
 * matches the target (or nothing to translate). Uses the dedicated translate
 * model. Idempotency is handled by the caller (part of the attendee-processing
 * job, keyed by the profile inputs hash).
 */
export async function translateProfileFields(
  llm: LlmProvider,
  translateModel: ModelRef,
  targetLang: string,
  fields: TranslationInput,
): Promise<AiProfile["translations"] | undefined> {
  const base = (targetLang || "en").toLowerCase();
  const hasContent =
    fields.about.trim() || fields.looking_for.trim() || fields.skills.length > 0;
  if (!hasContent) return undefined;
  const targetName = languageName(base);

  const user = [
    `TARGET LANGUAGE: ${targetName} (${base})`,
    "USER-AUTHORED FIELDS:",
    `About: ${fields.about}`,
    `Looking for: ${fields.looking_for}`,
    `Skills: ${fields.skills.join(", ")}`,
  ].join("\n");

  const { value } = await llm.completeStructured<RawTranslation>({
    system:
      `Detect the language of the user-authored fields. If it is already ${targetName} (${base}), set` +
      ` needs_translation=false and omit the translated fields. Otherwise set needs_translation=true and` +
      ` translate each non-empty field into ${targetName} (${base}), preserving meaning and proper nouns.` +
      " Return strict JSON.",
    user,
    schema: PROFILE_TRANSLATION_SCHEMA,
    schemaName: "profile_translation",
    model: translateModel.model,
    temperature: 0.1,
    validate: (raw): RawTranslation => translationResponseSchema.parse(raw),
  });

  if (!value?.needs_translation) return undefined;
  const out: NonNullable<AiProfile["translations"]> = { lang: base };
  if (fields.about.trim() && value.about) out.about = value.about;
  if (fields.looking_for.trim() && value.looking_for) out.looking_for = value.looking_for;
  if (fields.skills.length && Array.isArray(value.skills) && value.skills.length)
    out.skills = value.skills;
  // If detection said "translate" but produced nothing usable, skip.
  if (!out.about && !out.looking_for && !out.skills) return undefined;
  return out;
}

// ── Nostr-context summary (spec §9.2) ────────────────────────────────────────

export const NOSTR_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: {
    summary: { type: "string", description: "what this person is into, from their posts" },
  },
} as const;

export interface NostrPost {
  kind: number;
  content: string;
  created_at: number;
}

/** Hash of the nostr-context inputs (pubkey + the posts fed in + output language).
 *  FULL post content is hashed (audit COORD-22) — two different posts that share a
 *  40-char prefix must not collide onto the same cached summary. */
export function nostrInputsHash(pubkey: string, posts: NostrPost[], lang = "en", modelKey = ""): string {
  const canonical = JSON.stringify({
    pubkey,
    lang: (lang || "en").toLowerCase(),
    ids: posts.map((p) => `${p.kind}:${p.created_at}:${p.content}`),
    m: modelKey,
  });
  return sha256Hex(utf8ToBytes(canonical));
}

/** Extract the "about" bio from a kind-0 metadata event's JSON content, if any. */
function extractProfileBio(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content);
    const about = typeof parsed?.about === "string" ? parsed.about.trim() : "";
    return about || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Summarize an attendee's recent public activity with the cheap summary model.
 * Returns undefined when there's nothing to summarize (nostr_context=0 or empty,
 * or the only input is a kind-0 event with no usable "about" bio).
 */
export async function summarizeNostr(
  llm: LlmProvider,
  summaryModel: ModelRef,
  pubkey: string,
  posts: NostrPost[],
  lang = "en",
): Promise<string | undefined> {
  if (posts.length === 0) return undefined;
  const lines = posts.slice(0, 100).flatMap((p) => {
    if (p.kind === 0) {
      const bio = extractProfileBio(p.content);
      return bio ? [`- Profile bio: ${bio.replace(/\s+/g, " ").slice(0, 300)}`] : [];
    }
    return [`- ${p.content.replace(/\s+/g, " ").slice(0, 300)}`];
  });
  if (lines.length === 0) return undefined;
  const user = ["Recent public posts by this person (newest first):", ...lines].join("\n");
  const base = (lang || "en").toLowerCase();
  const langNote =
    base === "en"
      ? ""
      : ` The posts may be in any language; write the summary in ${languageName(base)} (${base}).`;
  const { value } = await llm.completeStructured<{ summary: string }>({
    system:
      "Summarize what this person is interested in and works on, based on their public posts. 2-3 sentences." +
      langNote,
    user,
    schema: NOSTR_SUMMARY_SCHEMA,
    schemaName: "nostr_summary",
    model: summaryModel.model,
    temperature: 0.3,
    validate: (raw) => nostrSummaryResponseSchema.parse(raw),
  });
  return value.summary;
}
