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
  MAX_SKILLS,
  MAX_SKILL,
  MAX_ABOUT,
  MAX_LOOKING_FOR,
  type AiProfile,
  type AttendeeProfile,
} from "@nostrautica/protocol";
import type { LlmProvider, ModelRef } from "../providers/types.js";
import { fenceUntrusted, fenceUntrustedList } from "./fencing.js";
import { promptRevision } from "./prompt-revision.js";

// ── Provider-output response schemas (audit finding Q9) ──────────────────────
// The model's raw JSON is validated at the provider boundary before it can enter
// storage or publication. The AI profile reuses the shared protocol schema; the
// translation/summary responses have their own local shapes.

/**
 * The AI never emits `translations` itself (the caller adds it), so only the core
 * fields are validated — extra keys are stripped, and a MISSING or WRONG-TYPED
 * field still throws a ProviderContractError, because a stage that did not return
 * a `skills` array has not done its job and there is nothing safe to guess.
 *
 * What is no longer a rejection is being over the protocol's SIZE caps
 * (2026-09-04 audit). This used to be `aiProfileSchema` itself, whose caps are
 * hard `.max()`s — so one 201-character skill, or a 51st list item, threw away the
 * attendee's whole ai_profile and with it their directory entry and every match
 * they would have had. Three things made that indefensible:
 *
 *  - `AI_PROFILE_SCHEMA`, the JSON schema we actually SEND the provider, carried no
 *    `maxLength`/`maxItems` at all, so the model was never told the bounds it was
 *    being punished for missing. It is told now.
 *  - `sanitizeAiProfile` truncates every one of these strings to 200 chars anyway,
 *    immediately after validation — so the reject only ever prevented work that was
 *    about to be undone.
 *  - The failure is deterministic for a given (prompt, model): every retry re-bills
 *    the same over-long skill, all the way to poison.
 *
 * Truncating instead is the same trade `coerceStringList` already makes for
 * translations, and for the same reason: an over-cap value fails every reader's
 * `directoryEntryContentSchema.parse`, silently removing the attendee from the
 * directory for EVERYONE, so the bound has to be enforced somewhere — just not by
 * discarding the answer.
 */
const boundedList = z
  .array(z.string())
  .transform((items) => items.slice(0, MAX_SKILLS).map((s) => s.slice(0, MAX_SKILL)));

const aiProfileResponseSchema = z.object({
  summary: z.string().transform((t) => t.slice(0, MAX_ABOUT)),
  skills: boundedList,
  interests: boundedList,
  offers: boundedList,
  seeks: boundedList,
});

/**
 * Liberal in what it accepts, because this stage is a DECORATION and the strict
 * reading of it cost real data (production incidents 2026-07-29 / 07-30).
 *
 * Two observed malformations, both `invalid_type` under the original
 * `.optional()` typing, both from `gemini-3-flash-preview`:
 *
 *  1. `"looking_for": null`. The system prompt says to translate each NON-EMPTY
 *     field, and the model marks the ones it skipped with null rather than
 *     omitting them. Every one of the 22 failures logged before the first fix
 *     named a field the attendee had left blank — never `about`, which nobody
 *     leaves blank.
 *  2. `"skills"` as a bare comma-joined STRING instead of an array. Seen on the
 *     first real run after the null fix shipped: the same profile's `ai_profile`
 *     call returned those terms as a proper array, so the model splits one
 *     authored skill into several and then hands them back joined.
 *
 *  3. A LIST where a paragraph was asked for — `looking_for` as an array. This
 *     one poisoned two attendees' whole `process_attendee` in July, because the
 *     first fix only covered `skills` and left the prose fields strict.
 *
 * All are deterministic for a given profile, so retrying could never help — it
 * just re-billed. `coerceString` and `coerceStringList` map each shape onto
 * "here is the text" or onto undefined, which is exactly how the caller already
 * treats a falsy value. Anything still unusable parses as undefined and the
 * field is simply not published: an untranslated field shows the author's own
 * words, which is a strictly better outcome than failing the stage.
 */

/**
 * Accept `["a","b"]`, `"a, b"` (the joined form), or junk → undefined.
 *
 * Bounded to the protocol's own caps, because splitting a string is a way to
 * INVENT list items: `translations` is attached after `aiProfileResponseSchema`
 * has already validated the model's output, so nothing else on this path enforces
 * `MAX_SKILLS`/`MAX_SKILL`. An over-cap list would encrypt and publish fine and
 * then fail `directoryEntryContentSchema.parse` in every reader — the attendee
 * would silently vanish from the directory for everyone, which is worse than the
 * malformed translation this coercion exists to tolerate.
 */
const coerceStringList = z.preprocess((v) => {
  const bound = (items: string[]) =>
    items.length > 0 ? items.slice(0, MAX_SKILLS).map((s) => s.slice(0, MAX_SKILL)) : undefined;
  if (typeof v === "string") {
    return bound(v.split(",").map((s) => s.trim()).filter(Boolean));
  }
  if (Array.isArray(v)) {
    return bound(v.filter((s): s is string => typeof s === "string" && s.trim() !== ""));
  }
  return undefined;
}, z.array(z.string()).optional());

/**
 * Accept a string, a list the model split into pieces (joined back), or junk →
 * undefined. The sibling of {@link coerceStringList}, and bounded for the same
 * reason: `translations` is attached after validation, so nothing downstream
 * enforces the protocol's caps, and an over-cap value publishes fine and then
 * fails every reader's `directoryEntryContentSchema.parse` — the attendee
 * silently vanishes from the directory.
 *
 * `skills` got this treatment in 10265d1; `about` and `looking_for` did not, and
 * stayed strict strings. Two `process_attendee` jobs poisoned on exactly that
 * gap ("looking_for: invalid_type", 2026-07-17 and 2026-07-20) — a translation
 * model handed back a list where a paragraph was asked for, and the whole
 * attendee's processing died with it.
 */
const coerceString = (max: number) =>
  z.preprocess((v) => {
    if (typeof v === "string") return v.slice(0, max);
    if (v == null) return undefined;
    if (Array.isArray(v)) {
      const parts = v.filter((s): s is string => typeof s === "string" && s.trim() !== "");
      return parts.length ? parts.join(", ").slice(0, max) : undefined;
    }
    return undefined;
  }, z.string().optional());

const translationResponseSchema = z.object({
  // The two detection fields stay STRICT (audit Q9). They are the answer to the
  // question that was asked, not the payload: a response missing them has not
  // done the job, and there is no safe way to guess. Only the translated CONTENT
  // is coerced — that is where production actually failed, and where a wrong
  // shape still carries usable text.
  source_lang: z.string(),
  needs_translation: z.boolean(),
  about: coerceString(MAX_ABOUT),
  looking_for: coerceString(MAX_LOOKING_FOR),
  skills: coerceStringList,
});

const nostrSummaryResponseSchema = z.object({ summary: z.string() });

/**
 * The JSON schema sent to the provider. The `maxLength`/`maxItems` bounds are the
 * protocol's own caps (2026-09-04 audit): they were absent, so the model was never
 * told the limits its output was then validated against — and a model that is told
 * "≤ 200 characters" in a strict `json_schema` mostly obeys, which is far cheaper
 * than truncating after the fact. The truncation in `aiProfileResponseSchema`
 * stays as the backstop for the models that do not.
 */
export const AI_PROFILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "skills", "interests", "offers", "seeks"],
  properties: {
    summary: {
      type: "string",
      maxLength: MAX_ABOUT,
      description: "2-3 sentence portrait of this person",
    },
    skills: {
      type: "array",
      maxItems: MAX_SKILLS,
      items: { type: "string", maxLength: MAX_SKILL },
    },
    interests: {
      type: "array",
      maxItems: MAX_SKILLS,
      items: { type: "string", maxLength: MAX_SKILL },
    },
    offers: {
      type: "array",
      maxItems: MAX_SKILLS,
      items: { type: "string", maxLength: MAX_SKILL },
      description: "what they can give others",
    },
    seeks: {
      type: "array",
      maxItems: MAX_SKILLS,
      items: { type: "string", maxLength: MAX_SKILL },
      description: "what they're looking for",
    },
  },
} as const;

const PROFILE_SYSTEM = [
  "You build a concise networking profile of a conference attendee from their intro",
  "video transcript, self-described profile, and a summary of their public posts.",
  "Extract concrete skills, interests, what they can OFFER others, and what they SEEK.",
  "Be specific and grounded in the inputs; do not invent. Return strict JSON.",
].join(" ");

/**
 * The translation stage's system prompt, as a named builder rather than an inline
 * template literal, so {@link promptRevision} can fingerprint it. Its only varying
 * parts are the target language's name and code, which the artifact hash already
 * carries separately.
 */
export function translationSystemPrompt(targetName: string, base: string): string {
  return (
    `Detect the language of the user-authored fields. If it is already ${targetName} (${base}), set` +
    ` needs_translation=false and omit the translated fields. Otherwise set needs_translation=true and` +
    ` translate each non-empty field into ${targetName} (${base}), preserving meaning and proper nouns.` +
    " Return strict JSON."
  );
}

/** The nostr-summary stage's system prompt; `langNote` is empty for English. */
export function nostrSummarySystemPrompt(langNote: string): string {
  return (
    "Summarize what this person is interested in and works on, based on their public posts. 2-3 sentences." +
    langNote
  );
}

/**
 * Prompt+schema fingerprints for the three artifacts this module produces
 * (audit PIPE-3). Folded into each artifact's inputs hash below, so editing a
 * prompt actually invalidates what that prompt produced.
 *
 * The language-varying prompts are fingerprinted with PLACEHOLDER language
 * arguments on purpose: the real language is hashed separately by every caller,
 * and baking it in here would give two English events different fingerprints for
 * an identical prompt.
 */
const AI_PROFILE_REVISION = promptRevision(PROFILE_SYSTEM, AI_PROFILE_SCHEMA);
// TRANSLATION_REVISION and NOSTR_SUMMARY_REVISION are declared beside their own
// schemas further down, since a module-scope const cannot read one declared later.

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
    // The prompt that produces this artifact, fingerprinted from its source. This
    // was the hand-written string "ai_profile.v1", which nobody ever bumped — so
    // every prompt edit since kept serving profiles built by the previous one.
    schema: AI_PROFILE_REVISION,
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
    schema: TRANSLATION_REVISION,
  });
  return sha256Hex(utf8ToBytes(canonical));
}

export async function buildAiProfile(
  llm: LlmProvider,
  matchModel: ModelRef,
  inputs: ProfileInputs,
  signal?: AbortSignal,
): Promise<AiProfile> {
  // Everything here is written or spoken by the person being profiled, and it is
  // being pasted under headers the model reads as structure — including the `---`
  // that separates one transcript from the next. Fence it (audit SEC-15): a bio
  // saying "PUBLIC NOSTR ACTIVITY:" followed by invented history would otherwise
  // be read as this daemon's own attestation of that history.
  const p = inputs.profile;
  const user = [
    inputs.transcripts.length
      ? `INTRO/TALK TRANSCRIPT:\n${inputs.transcripts.map(fenceUntrusted).join("\n---\n")}`
      : "",
    `SELF-DESCRIBED PROFILE:\nAbout: ${fenceUntrusted(p.about)}\nSkills: ${fenceUntrustedList(p.skills).join(", ")}\nLooking for: ${fenceUntrusted(p.looking_for)}`,
    inputs.nostrSummary ? `PUBLIC NOSTR ACTIVITY:\n${fenceUntrusted(inputs.nostrSummary)}` : "",
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
    signal,
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

const TRANSLATION_REVISION = promptRevision(
  translationSystemPrompt("«lang»", "«code»"),
  PROFILE_TRANSLATION_SCHEMA,
);

interface RawTranslation {
  source_lang?: string;
  needs_translation?: boolean;
  about?: string | null;
  looking_for?: string | null;
  skills?: string[] | null;
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
  signal?: AbortSignal,
): Promise<AiProfile["translations"] | undefined> {
  const base = (targetLang || "en").toLowerCase();
  const hasContent =
    fields.about.trim() || fields.looking_for.trim() || fields.skills.length > 0;
  if (!hasContent) return undefined;
  const targetName = languageName(base);

  const user = [
    `TARGET LANGUAGE: ${targetName} (${base})`,
    "USER-AUTHORED FIELDS:",
    // The name of this section says what it is; fence it anyway (audit SEC-15).
    // The output here is republished verbatim as the attendee's translated
    // directory entry, so a field that talks the model out of translating and
    // into writing something else publishes that something else.
    `About: ${fenceUntrusted(fields.about)}`,
    `Looking for: ${fenceUntrusted(fields.looking_for)}`,
    `Skills: ${fenceUntrustedList(fields.skills).join(", ")}`,
  ].join("\n");

  const { value } = await llm.completeStructured<RawTranslation>({
    system: translationSystemPrompt(targetName, base),
    user,
    schema: PROFILE_TRANSLATION_SCHEMA,
    schemaName: "profile_translation",
    model: translateModel.model,
    temperature: 0.1,
    validate: (raw): RawTranslation => translationResponseSchema.parse(raw),
    signal,
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

const NOSTR_SUMMARY_REVISION = promptRevision(
  nostrSummarySystemPrompt("«langNote»"),
  NOSTR_SUMMARY_SCHEMA,
);

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
    // This one had no prompt field at ALL, unlike its two siblings.
    schema: NOSTR_SUMMARY_REVISION,
  });
  return sha256Hex(utf8ToBytes(canonical));
}

/**
 * Extract the "about" bio from a kind-0 metadata event's JSON content, if any.
 *
 * Exported because it is also the CHANGE-DETECTION input for the periodic
 * profile-refresh sweep (`Coordinator.profileRefreshSweep`). The sweep must hash
 * exactly the kind-0 field this pipeline reads and nothing else: `about` is the
 * only part of a kind 0 that reaches the model (see `summarizeNostr` below), so
 * hashing the whole event would re-enrich — and re-rank — every time somebody
 * fixed their lud16 or swapped their avatar, which changes no model input at all.
 */
export function extractProfileBio(content: string): string | undefined {
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
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (posts.length === 0) return undefined;
  // Public Nostr posts: authored by the attendee, but ALSO by anyone the attendee
  // can get to post — the least trusted input the daemon reads (audit SEC-15).
  const clean = (t: string) => fenceUntrusted(t).replace(/\s+/g, " ").slice(0, 300);
  const lines = posts.slice(0, 100).flatMap((p) => {
    if (p.kind === 0) {
      const bio = extractProfileBio(p.content);
      return bio ? [`- Profile bio: ${clean(bio)}`] : [];
    }
    return [`- ${clean(p.content)}`];
  });
  if (lines.length === 0) return undefined;
  const user = ["Recent public posts by this person (newest first):", ...lines].join("\n");
  const base = (lang || "en").toLowerCase();
  const langNote =
    base === "en"
      ? ""
      : ` The posts may be in any language; write the summary in ${languageName(base)} (${base}).`;
  const { value } = await llm.completeStructured<{ summary: string }>({
    system: nostrSummarySystemPrompt(langNote),
    user,
    schema: NOSTR_SUMMARY_SCHEMA,
    schemaName: "nostr_summary",
    model: summaryModel.model,
    temperature: 0.3,
    validate: (raw) => nostrSummaryResponseSchema.parse(raw),
    signal,
  });
  return value.summary;
}
