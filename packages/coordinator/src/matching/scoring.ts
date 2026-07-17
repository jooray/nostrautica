/**
 * Pair scoring (spec §9.3, §16.2). Scoring is BATCHED and DIRECTIONAL: one LLM
 * call scores ONE target attendee against ≤K candidates using the BP3 prompt from
 * docs/MATCHING-BENCHMARK.md (rubric anchors + user-facing host-voice reasoning).
 * Scoring MUST explicitly reward complementarity (skills that complete each other
 * for this event's purpose), not just similarity.
 */
import { z } from "zod";
import { sha256Hex, utf8ToBytes, languageName } from "@nostrautica/protocol";
import type { AiProfile } from "@nostrautica/protocol";
import type { LlmProvider } from "../providers/types.js";

/**
 * Lenient envelope validation for batch-score output (audit finding Q9). This
 * only asserts the response is an object whose `matches` (when present) is an
 * array of objects — a non-JSON-object response, or `matches` that isn't an
 * array, is rejected at the provider boundary → retry/poison. Per-candidate
 * fields stay deliberately tolerant below (a single bad row must not poison the
 * whole batch: `normalizeScore` coerces and out-of-range/duplicate rows are
 * skipped), so the item shape is intentionally loose here.
 */
const batchScoreResponseSchema = z
  .object({ matches: z.array(z.record(z.unknown())).optional() })
  .passthrough();

/** A fully-scored pair, both directions at once (legacy pairwise rows / tests). */
export interface PairScore {
  score: number;
  similarity: number;
  complementarity: number;
  /** Addressed to PERSON A ("you"), explaining why A should meet B. */
  reasoningForA: string;
  /** Addressed to PERSON B ("you"), explaining why B should meet A. */
  reasoningForB: string;
}

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

function profileText(p: AiProfile, name?: string): string {
  return [
    // B1: without a Name line the model cannot address anyone correctly and
    // falls back to inventing one (it copied "Elena" from the prompt example).
    ...(name ? [`Name: ${name}`] : []),
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
  /** Event language (ISO 639-1). Reasoning is written in this language. */
  lang: string;
}

/**
 * Output-language instruction appended to a scoring prompt (spec §9.3). BP3 is
 * benchmark-validated and must not be reworded, so this is a separate trailing
 * block. For English events it is empty (no stray "write in English" phrasing).
 * Attendee inputs may be in ANY language — the model must translate as needed.
 */
export function languageInstruction(lang: string): string {
  const base = (lang || "en").toLowerCase();
  if (base === "en") return "";
  const name = languageName(base);
  return [
    "",
    "OUTPUT LANGUAGE:",
    "The attendee profiles below may be written in any language (English profiles at a",
    `${name}-language event are normal). Regardless of the input language, write every`,
    `reasoning string in ${name} (${base}). All other JSON fields (scores) are unchanged.`,
  ].join("\n");
}

// ── Batched scoring (spec §9.3, §16.2) ────────────────────────────────────────
// One call scores ONE target attendee against K candidates. The model returns a
// per-candidate {similarity, complementarity, score, reasoning_for_target}, where
// the reasoning is addressed to the TARGET ("you"). The reverse direction is
// produced when the candidate is itself the target of its own batch. This is a
// transport optimization only — results are written per directed pair, keyed by
// inputs_hash, so idempotency and incremental re-scoring are unchanged.

/** Directed score of one candidate FROM the target's point of view. */
export interface DirectedScore {
  score: number;
  similarity: number;
  complementarity: number;
  /** Addressed to the TARGET as "you": why the target should meet this candidate. */
  reasoning: string;
}

/**
 * BP3 (docs/MATCHING-BENCHMARK.md appendix) — host-voice reasoning + rubric
 * anchors. Verbatim: rubric anchors roughly double strong-vs-weak separation and
 * the host-voice block makes the reasoning shippable (judged 4.53/5, near-zero
 * meta-commentary). Do NOT paraphrase — the exact wording is load-bearing (the
 * report notes colorful rubric phrases leak into output, so keep it drab).
 */
export const BATCH_SYSTEM_PROMPT = [
  "You are a conference matchmaker for the event described below. You are given ONE target attendee",
  "and a numbered list of candidate attendees. For EACH candidate, judge how valuable it would be",
  "for the TARGET to meet them, considering what THIS event is for.",
  "",
  "Score three fields, each a DECIMAL between 0.0 and 1.0 (never 0-10 or 0-100):",
  " • similarity: shared interests, background, or goals.",
  " • complementarity: how much their skills/roles COMPLETE each other for this event — one has what",
  "   the other needs (a founder needing a Rust dev + a Rust dev wanting a mission; a drummer + a",
  "   bassist; powerful-but-unusable tech + a designer). This is the most important signal.",
  " • score: overall value of the meeting. A meeting is high-value when one person's SEEKS is met by",
  "   the other's OFFERS/skills (in either direction). Reward that fit heavily.",
  "",
  "Score anchors for `score`: 0.9-1.0 = a near-perfect mutual fit (each solves the other's stated need);",
  " 0.7-0.85 = strong one-directional or clearly useful fit; 0.4-0.6 = plausible, some overlap but no",
  " sharp need met; 0.15-0.35 = weak, only vague topical overlap; 0.0-0.1 = no real reason to meet.",
  "",
  "Scoring rules:",
  " • Score each candidate INDEPENDENTLY on its own merits. Do not let an early strong candidate inflate",
  "   later ones, or let a strong batch drag up a weak candidate. Use the FULL range — most candidates in",
  "   a batch should NOT score high.",
  " • Ground every judgement in the ACTUAL profile text. Never invent skills, goals, or facts.",
  "",
  "reasoning_for_target — THIS TEXT IS SHOWN DIRECTLY TO THE TARGET ATTENDEE. Write 1-2 sentences in",
  "the voice of a good host introducing them to the candidate:",
  ' • Second person, direct: "You should grab Elena — ...", "Ask him about ...".',
  " • The TARGET is always \"you\". Call the candidate by the Name given in THEIR profile — never a",
  '   name from these instructions or examples ("Elena"/"Sunny" are example names, not attendees).',
  " • Name a CONCRETE thing to talk about or do together, drawn from both people's actual details.",
  ' • ABSOLUTELY NO analytical framing: never say "this pair", "based on their profiles", "high',
  '   complementarity", "scores", "match", or explain why a rating was given. No hedging boilerplate.',
  'Example of GOOD: "You\'ve been hunting for a bassist — Sunny plays bass, she\'s new in town and dead',
  'serious about joining a band; ask her what she\'d want your first setlist to sound like."',
  'Example of BAD (never do this): "This pair has high complementarity because both are musicians',
  'seeking bandmates, resulting in a strong match score."',
  "",
  "Return one entry per candidate, using the candidate's number as `index`. Score EVERY candidate exactly once.",
].join("\n");

/** Strict JSON schema: an object with a `matches` array, one entry per candidate. */
export const BATCH_SCORE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matches"],
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "similarity", "complementarity", "score", "reasoning_for_target"],
        properties: {
          index: { type: "number", description: "the candidate number this entry scores" },
          similarity: { type: "number" },
          complementarity: { type: "number" },
          score: { type: "number" },
          reasoning_for_target: {
            type: "string",
            description:
              "Addressed to the TARGET as 'you': a host-voice, 1-2 sentence hook for meeting this candidate. No analytical framing.",
          },
        },
      },
    },
  },
} as const;

interface RawBatchMatch {
  index: number;
  similarity: number;
  complementarity: number;
  score: number;
  reasoning_for_target: string;
}

/** A candidate in a batch, tagged with the caller's stable id (pubkey). */
export interface BatchCandidate {
  id: string;
  profile: AiProfile;
  /** Display name (B1) so reasoning can call the person by their actual name. */
  name?: string;
}

export interface BatchScoreResult {
  /** Directed scores keyed by candidate id. Missing ids failed to parse and must be retried. */
  scores: Map<string, DirectedScore>;
  /** Candidate ids the model did not return a valid entry for. */
  missing: string[];
}

/**
 * Deterministic Fisher–Yates shuffle driven by an injectable rng. Batches shuffle
 * candidate order to spread residual position bias (benchmark: corr 0.0–0.16 at
 * K=10; deepseek-v4-flash −0.01).
 */
function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * Score one target against K candidates in a single LLM call. Per-candidate parse:
 * a malformed/missing candidate is reported in `missing` and never poisons the rest
 * of the batch (the caller retries it individually or in the next batch).
 */
export async function scoreBatch(
  llm: LlmProvider,
  model: string,
  event: EventContextForScoring,
  target: AiProfile,
  candidates: readonly BatchCandidate[],
  rng: () => number = Math.random,
  targetName?: string,
): Promise<BatchScoreResult> {
  const scores = new Map<string, DirectedScore>();
  if (candidates.length === 0) return { scores, missing: [] };

  // Shuffle to spread position bias; `index` (1-based) maps back to the candidate.
  const ordered = shuffle(candidates, rng);
  const eventBlock = [
    `EVENT: ${event.title}`,
    event.summary ? `ABOUT: ${event.summary}` : "",
    event.hashtags.length ? `TOPICS: ${event.hashtags.join(", ")}` : "",
  ].filter(Boolean);

  const user = [
    ...eventBlock,
    "",
    "TARGET ATTENDEE:",
    profileText(target, targetName),
    "",
    "CANDIDATES:",
    ...ordered.map((c, i) => [`--- CANDIDATE ${i + 1} ---`, profileText(c.profile, c.name)].join("\n")),
  ].join("\n");

  const { value } = await llm.completeStructured<{ matches?: RawBatchMatch[] }>({
    system: BATCH_SYSTEM_PROMPT + languageInstruction(event.lang),
    user,
    schema: BATCH_SCORE_SCHEMA,
    schemaName: "batch_score",
    model,
    temperature: 0.3,
    validate: (raw) => batchScoreResponseSchema.parse(raw) as { matches?: RawBatchMatch[] },
  });

  const matches = Array.isArray(value?.matches) ? value.matches : [];
  const seen = new Set<number>();
  for (const m of matches) {
    const idx = Number(m?.index);
    // 1-based index into `ordered`; ignore out-of-range / duplicate / malformed.
    if (!Number.isInteger(idx) || idx < 1 || idx > ordered.length) continue;
    if (seen.has(idx)) continue;
    if (typeof m.reasoning_for_target !== "string" || m.reasoning_for_target === "") continue;
    seen.add(idx);
    const cand = ordered[idx - 1]!;
    scores.set(cand.id, {
      score: normalizeScore(m.score),
      similarity: normalizeScore(m.similarity),
      complementarity: normalizeScore(m.complementarity),
      reasoning: m.reasoning_for_target,
    });
  }

  const missing = candidates.filter((c) => !scores.has(c.id)).map((c) => c.id);
  return { scores, missing };
}

// ── Reverse-batch scoring (spec §16.2) ────────────────────────────────────────
// When ONE attendee changes, the forward direction (changed→others) batches
// cleanly, but the reverse (each other→changed) is N−1 targets with a single
// pending candidate each — naive grouping degrades to N−1 one-candidate calls.
// This variant inverts the shape: ONE shared candidate + K targets per call,
// "for each of these people, why should THEY meet the shared person". It mirrors
// BP3 (same rubric anchors, host voice, grounding, language) so scores stay
// comparable — only the loop direction differs. Output is per-TARGET, addressed
// to that target ("you").

/** BP3 mirror: score K targets against ONE shared candidate, per-target reasoning. */
export const REVERSE_BATCH_SYSTEM_PROMPT = [
  "You are a conference matchmaker for the event described below. You are given ONE shared person",
  "and a numbered list of target attendees. For EACH target, judge how valuable it would be",
  "for that TARGET to meet the shared person, considering what THIS event is for.",
  "",
  "Score three fields, each a DECIMAL between 0.0 and 1.0 (never 0-10 or 0-100):",
  " • similarity: shared interests, background, or goals.",
  " • complementarity: how much their skills/roles COMPLETE each other for this event — one has what",
  "   the other needs (a founder needing a Rust dev + a Rust dev wanting a mission; a drummer + a",
  "   bassist; powerful-but-unusable tech + a designer). This is the most important signal.",
  " • score: overall value of the meeting. A meeting is high-value when one person's SEEKS is met by",
  "   the other's OFFERS/skills (in either direction). Reward that fit heavily.",
  "",
  "Score anchors for `score`: 0.9-1.0 = a near-perfect mutual fit (each solves the other's stated need);",
  " 0.7-0.85 = strong one-directional or clearly useful fit; 0.4-0.6 = plausible, some overlap but no",
  " sharp need met; 0.15-0.35 = weak, only vague topical overlap; 0.0-0.1 = no real reason to meet.",
  "",
  "Scoring rules:",
  " • Score each target INDEPENDENTLY on its own merits. Do not let an early strong target inflate",
  "   later ones, or let a strong batch drag up a weak target. Use the FULL range — most targets in",
  "   a batch should NOT score high.",
  " • Ground every judgement in the ACTUAL profile text. Never invent skills, goals, or facts.",
  "",
  "reasoning_for_target — THIS TEXT IS SHOWN DIRECTLY TO THE TARGET ATTENDEE. Write 1-2 sentences in",
  "the voice of a good host introducing them to the shared person:",
  ' • Second person, direct: "You should grab Elena — ...", "Ask him about ...".',
  " • Each TARGET is always \"you\" in their own entry — describe the SHARED person to them, never the",
  "   other way around. Call the shared person by the Name given in THEIR profile — never a name from",
  '   these instructions or examples ("Elena" is an example name, not an attendee).',
  " • Name a CONCRETE thing to talk about or do together, drawn from both people's actual details.",
  ' • ABSOLUTELY NO analytical framing: never say "this pair", "based on their profiles", "high',
  '   complementarity", "scores", "match", or explain why a rating was given. No hedging boilerplate.',
  "",
  "Return one entry per target, using the target's number as `index`. Score EVERY target exactly once.",
].join("\n");

/**
 * Score K targets against one shared candidate in a single call. `targets` carry
 * the caller's stable id (the target pubkey); the returned map is keyed by that
 * id, each score addressed to that target ("you should meet the shared person").
 */
export async function scoreReverseBatch(
  llm: LlmProvider,
  model: string,
  event: EventContextForScoring,
  shared: AiProfile,
  targets: readonly BatchCandidate[],
  rng: () => number = Math.random,
  sharedName?: string,
): Promise<BatchScoreResult> {
  const scores = new Map<string, DirectedScore>();
  if (targets.length === 0) return { scores, missing: [] };

  const ordered = shuffle(targets, rng);
  const eventBlock = [
    `EVENT: ${event.title}`,
    event.summary ? `ABOUT: ${event.summary}` : "",
    event.hashtags.length ? `TOPICS: ${event.hashtags.join(", ")}` : "",
  ].filter(Boolean);

  const user = [
    ...eventBlock,
    "",
    "SHARED PERSON (the one each target below would meet):",
    profileText(shared, sharedName),
    "",
    "TARGET ATTENDEES:",
    ...ordered.map((c, i) => [`--- TARGET ${i + 1} ---`, profileText(c.profile, c.name)].join("\n")),
  ].join("\n");

  const { value } = await llm.completeStructured<{ matches?: RawBatchMatch[] }>({
    system: REVERSE_BATCH_SYSTEM_PROMPT + languageInstruction(event.lang),
    user,
    schema: BATCH_SCORE_SCHEMA,
    schemaName: "reverse_batch_score",
    model,
    temperature: 0.3,
    validate: (raw) => batchScoreResponseSchema.parse(raw) as { matches?: RawBatchMatch[] },
  });

  const matches = Array.isArray(value?.matches) ? value.matches : [];
  const seen = new Set<number>();
  for (const m of matches) {
    const idx = Number(m?.index);
    if (!Number.isInteger(idx) || idx < 1 || idx > ordered.length) continue;
    if (seen.has(idx)) continue;
    if (typeof m.reasoning_for_target !== "string" || m.reasoning_for_target === "") continue;
    seen.add(idx);
    const tgt = ordered[idx - 1]!;
    scores.set(tgt.id, {
      score: normalizeScore(m.score),
      similarity: normalizeScore(m.similarity),
      complementarity: normalizeScore(m.complementarity),
      reasoning: m.reasoning_for_target,
    });
  }

  const missing = targets.filter((t) => !scores.has(t.id)).map((t) => t.id);
  return { scores, missing };
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
