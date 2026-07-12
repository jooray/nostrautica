/**
 * Pair scoring (spec §9.3). The prompt takes both ai_profiles + event context and
 * returns strict-JSON {score, similarity, complementarity, reasoning}. Scoring
 * MUST explicitly reward complementarity (skills that complete each other for
 * this event's purpose), not just similarity.
 */
import { sha256Hex, utf8ToBytes } from "@nostrautica/protocol";
import type { AiProfile } from "@nostrautica/protocol";
import type { LlmProvider } from "../providers/types.js";

export interface PairScore {
  score: number;
  similarity: number;
  complementarity: number;
  /** Addressed to PERSON A ("you"), explaining why A should meet B. */
  reasoningForA: string;
  /** Addressed to PERSON B ("you"), explaining why B should meet A. */
  reasoningForB: string;
}

/** Strict JSON schema for structured output (additionalProperties:false, all required). */
export const PAIR_SCORE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "similarity", "complementarity", "reasoning_for_a", "reasoning_for_b"],
  properties: {
    score: { type: "number", description: "0..1 overall how much they should meet" },
    similarity: { type: "number", description: "0..1 shared interests/background" },
    complementarity: {
      type: "number",
      description: "0..1 how much their skills complete each other for this event",
    },
    reasoning_for_a: {
      type: "string",
      description:
        "Addressed to PERSON A as 'you', explaining why YOU (A) should meet B — reference A's own goals/skills and what B offers A. 1-2 sentences, specific, not generic.",
    },
    reasoning_for_b: {
      type: "string",
      description:
        "Addressed to PERSON B as 'you', explaining why YOU (B) should meet A — reference B's own goals/skills and what A offers B. 1-2 sentences, specific, not generic.",
    },
  },
} as const;

interface RawPairScore {
  score: number;
  similarity: number;
  complementarity: number;
  reasoning_for_a: string;
  reasoning_for_b: string;
}

export const PAIR_SYSTEM_PROMPT = [
  "You are a conference matchmaker. Given two attendees' AI profiles and the event context,",
  "score how valuable it would be for them to meet.",
  "Reward COMPLEMENTARITY — skills/roles that complete each other for THIS event's purpose",
  "(e.g. a cryptographer + a designer + a programmer at a cypherpunk event; a drummer + a",
  "bassist + a singer at a music gathering) — at least as much as similarity. Two people who",
  "are near-identical should score lower than two who fit together like puzzle pieces.",
  "CRITICAL: score, similarity, and complementarity are each a DECIMAL FRACTION between",
  "0.0 and 1.0 (e.g. 0.85). Never use a 0-10 or 0-100 scale.",
  "Write TWO separate reasonings, each addressed to that person as \"you\": reasoning_for_a",
  "tells PERSON A why THEY should meet B (grounded in A's own goals/skills and what B brings",
  "A); reasoning_for_b tells PERSON B why THEY should meet A. They are NOT the same sentence",
  "with names swapped — each speaks to that person's specific situation. Plain language,",
  "specific, never a bare score.",
].join(" ");

/** Clamp to [0,1], rescaling values the model returned on a 0-10 / 0-100 scale. */
function normalizeScore(v: number): number {
  let x = typeof v === "number" && isFinite(v) ? v : 0;
  if (x > 1) x = x > 10 ? x / 100 : x / 10;
  return Math.max(0, Math.min(1, x));
}

/** Canonical hash of an ai_profile, for pair-cache invalidation (spec §9.3). */
export function profileHash(profile: AiProfile): string {
  const canonical = JSON.stringify({
    summary: profile.summary,
    skills: [...profile.skills].sort(),
    interests: [...profile.interests].sort(),
    offers: [...profile.offers].sort(),
    seeks: [...profile.seeks].sort(),
  });
  return sha256Hex(utf8ToBytes(canonical));
}

/** inputs_hash = sha256(sorted(profileA_hash, profileB_hash)) — order-independent. */
export function pairInputsHash(hashA: string, hashB: string): string {
  const [x, y] = hashA < hashB ? [hashA, hashB] : [hashB, hashA];
  return sha256Hex(utf8ToBytes(`${x}|${y}`));
}

function profileText(p: AiProfile): string {
  return [
    `Summary: ${p.summary}`,
    `Skills: ${p.skills.join(", ")}`,
    `Interests: ${p.interests.join(", ")}`,
    `Offers: ${p.offers.join(", ")}`,
    `Seeks: ${p.seeks.join(", ")}`,
  ].join("\n");
}

export interface EventContextForScoring {
  title: string;
  summary: string;
  hashtags: string[];
}

/** Score one pair via the LLM (caller handles caching). */
export async function scorePair(
  llm: LlmProvider,
  model: string,
  event: EventContextForScoring,
  a: AiProfile,
  b: AiProfile,
): Promise<PairScore> {
  const user = [
    `EVENT: ${event.title}`,
    event.summary ? `ABOUT: ${event.summary}` : "",
    event.hashtags.length ? `TOPICS: ${event.hashtags.join(", ")}` : "",
    "",
    "PERSON A:",
    profileText(a),
    "",
    "PERSON B:",
    profileText(b),
  ]
    .filter(Boolean)
    .join("\n");

  const { value } = await llm.completeStructured<RawPairScore>({
    system: PAIR_SYSTEM_PROMPT,
    user,
    schema: PAIR_SCORE_SCHEMA,
    schemaName: "pair_score",
    model,
    temperature: 0.3,
  });
  // Defensively normalize — models don't reliably honor the 0..1 range.
  return {
    score: normalizeScore(value.score),
    similarity: normalizeScore(value.similarity),
    complementarity: normalizeScore(value.complementarity),
    reasoningForA: value.reasoning_for_a,
    reasoningForB: value.reasoning_for_b,
  };
}

/** Cosine similarity between two equal-length vectors. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
