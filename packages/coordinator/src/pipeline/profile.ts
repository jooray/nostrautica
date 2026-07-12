/**
 * AI profile building (spec §9.2). Combines the intro/talk transcript(s), the
 * attendee's submitted profile text, and a summary of their public Nostr activity
 * into a strict-JSON ai_profile {summary, skills, interests, offers, seeks}.
 *
 * Every step is cached by an input hash so a restart never re-bills.
 */
import {
  sha256Hex,
  utf8ToBytes,
  type AiProfile,
  type AttendeeProfile,
} from "@nostrautica/protocol";
import type { LlmProvider, ModelRef } from "../providers/types.js";

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

export interface ProfileInputs {
  transcripts: string[];
  profile: AttendeeProfile;
  nostrSummary?: string;
}

/** Deterministic hash of all profile inputs (for the profiles cache). */
export function profileInputsHash(inputs: ProfileInputs): string {
  const canonical = JSON.stringify({
    t: inputs.transcripts,
    p: inputs.profile,
    n: inputs.nostrSummary ?? "",
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
    system: PROFILE_SYSTEM,
    user,
    schema: AI_PROFILE_SCHEMA,
    schemaName: "ai_profile",
    model: matchModel.model,
    temperature: 0.2,
  });
  return value;
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

/** Hash of the nostr-context inputs (pubkey + the posts fed in). */
export function nostrInputsHash(pubkey: string, posts: NostrPost[]): string {
  const canonical = JSON.stringify({
    pubkey,
    ids: posts.map((p) => `${p.kind}:${p.created_at}:${p.content.slice(0, 40)}`),
  });
  return sha256Hex(utf8ToBytes(canonical));
}

/**
 * Summarize an attendee's recent public activity with the cheap summary model.
 * Returns undefined when there's nothing to summarize (nostr_context=0 or empty).
 */
export async function summarizeNostr(
  llm: LlmProvider,
  summaryModel: ModelRef,
  pubkey: string,
  posts: NostrPost[],
): Promise<string | undefined> {
  if (posts.length === 0) return undefined;
  const user = [
    "Recent public posts by this person (newest first):",
    ...posts.slice(0, 100).map((p) => `- ${p.content.replace(/\s+/g, " ").slice(0, 300)}`),
  ].join("\n");
  const { value } = await llm.completeStructured<{ summary: string }>({
    system:
      "Summarize what this person is interested in and works on, based on their public posts. 2-3 sentences.",
    user,
    schema: NOSTR_SUMMARY_SCHEMA,
    schemaName: "nostr_summary",
    model: summaryModel.model,
    temperature: 0.3,
  });
  return value.summary;
}
