/**
 * Pair scoring (spec §9.3, §16.2). Scoring is BATCHED and DIRECTIONAL: one LLM
 * call scores ONE target attendee against ≤K candidates using the BP3 prompt from
 * docs/MATCHING-BENCHMARK.md (rubric anchors + user-facing host-voice reasoning).
 * Scoring MUST explicitly reward complementarity (skills that complete each other
 * for this event's purpose), not just similarity.
 */
import { z } from "zod";
import { sha256Hex, utf8ToBytes, languageName, hasAiProfileContent } from "@nostrautica/protocol";
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

/**
 * A profile with no content must never be scored. `profileText` renders one as a
 * "Name: X" line over five empty fields, and the model, asked to explain how two
 * people fit, obliges: production scored a content-free attendee at 0.85–0.90
 * against six different targets, each time inventing a DIFFERENT plausible
 * biography from the name alone ("he works on MeshCore and BTC L2") in flat
 * defiance of the prompt's "never invent" rule. Confabulation is not something a
 * better prompt fixes — the only safe input is one with something in it.
 *
 * Re-exported from the protocol package so the coordinator's notion of "empty"
 * is the same one the app renders by (see `hasAiProfileContent`).
 */
export const hasProfileContent = hasAiProfileContent;

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
 *
 * It also re-states the icebreaker SENDER/RECIPIENT binding, because prod
 * 2026-07-25 (Slovak event) inverted it while getting the same ownership RIGHT in
 * `reasoning_for_target` one field earlier: WHO IS WHO is necessarily written with
 * English pronoun tokens, and carrying "my"/"your" into môj/tvoj was left to
 * guesswork. This block is the only place that knows which language the output is
 * actually in, and it is last in the system prompt (highest recency), so the
 * binding is repeated here in terms of ROLES rather than English words.
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
    `reasoning string and every icebreaker in ${name} (${base}). All other JSON fields (scores) are`,
    "unchanged.",
    `Translating moves no ownership. In the icebreakers, ${name}'s FIRST-person possessive forms`,
    "still mean the SENDER (the attendee this entry is written for, the one who will send the",
    `message) and ${name}'s SECOND-person possessive forms still mean the RECIPIENT (the other`,
    `person). Use ${name}'s own forms for that distinction, and never attach a second-person`,
    "possessive to anything that appears in the SENDER's own profile block.",
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
  /** ≤ 3 short conversation starters the TARGET can open with (NIP §6.2). */
  icebreakers?: string[];
}

/** Icebreaker bounds (NIP §6.2): ≤ 3 entries, ≤ 280 chars each. */
export const MAX_ICEBREAKERS = 3;
export const MAX_ICEBREAKER_LEN = 280;

/**
 * Coerce a raw model `icebreakers` value into a bounded string[] (NIP §6.2):
 * keep only non-empty strings, trim to MAX_ICEBREAKER_LEN, cap at MAX_ICEBREAKERS.
 * Anything else (absent, not an array) yields undefined so the field stays off the
 * match entry. Publish-boundary URL-neutralization happens later (sanitizeMatchList).
 */
function normalizeIcebreakers(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  // Deduped BEFORE the cap, so three starters two of which are identical still
  // ship two distinct ones rather than a padded list. Clients key their render on
  // the icebreaker STRING (Matches.svelte), and in Svelte 5 a duplicate {#each}
  // key is a hard throw that kills the route — asking a model for three openers
  // on one shared interest repeats itself often enough that this is a real crash
  // vector, not a tidiness concern. Truncation is applied first: two long
  // starters sharing a 280-char prefix become identical only after slicing.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== "string" || s.trim() === "") continue;
    const clipped = s.slice(0, MAX_ICEBREAKER_LEN);
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    out.push(clipped);
    if (out.length >= MAX_ICEBREAKERS) break;
  }
  return out.length > 0 ? out : undefined;
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
  "icebreakers — up to THREE opening MESSAGES the target can send this candidate. The app pastes the",
  "FIRST one straight into a direct-message box addressed to this candidate, so it must be sendable",
  "as-is, with no editing.",
  "WHO IS WHO. This is the most important rule. Compared with the field above only the PRONOUNS",
  "change — the two people keep their roles, they never swap:",
  ' • SENDER = the person under TARGET ATTENDEE. They are typing, so first person ("I"/"my") is',
  "   always them. Everything under TARGET ATTENDEE — their book, app, courses, company, job,",
  '   skills — is the SENDER\'s own and is "my", NEVER "your".',
  ' • RECIPIENT = THIS candidate. Second person ("you"/"your") is always them. Only what appears',
  '   under THIS candidate\'s own heading may be called "your".',
  " • Never hand one person's work to the other. If the SENDER wrote a novel, never ask the",
  '   RECIPIENT about "your novel" — the SENDER wrote it, so it is "my novel". If the RECIPIENT',
  '   built a tool, never call it "my tool". The SENDER does not borrow the RECIPIENT\'s job,',
  "   profession or skills either.",
  " • WHOSE IS IT, when both profiles name the same thing: a candidate's profile may mention",
  "   something the SENDER made — they read it, funded it, drew its cover, did its branding, or list",
  '   it as a "hot project" they worked on. A mention does NOT transfer authorship. The TARGET',
  "   ATTENDEE block is the authority on what the SENDER made: anything it presents as the target's",
  '   stays "my", however prominently a candidate lists it.',
  '   MECHANICAL CHECK before you write "your <name>" (or that phrase in another language): find that',
  "   name in BOTH blocks. If it appears in the TARGET ATTENDEE block at all, the phrase is FORBIDDEN",
  '   — it is the SENDER\'s, so write "my <name>". Only a name that appears solely under THIS',
  '   candidate\'s heading may take "your". Their contribution to it ("your cover", "your branding")',
  "   still takes second person; the thing itself does not.",
  " • Write a message, not a briefing. Describing the two of them to a third party (\"You're a",
  '   cypherpunk and she studies X — ask her about Y") cannot be sent to anyone; do not do it.',
  " • This is a rule about ROLES, not about the English words. It holds in whatever language you",
  "   write in: use that language's own first-person possessive forms for the SENDER and its",
  "   second-person possessive forms for the RECIPIENT. The forms change; the owner never does.",
  "Re-read each icebreaker before returning it: every second-person possessive must point at",
  "something from THIS candidate's block, every first-person one at something from the TARGET",
  "ATTENDEE block. If one does not, the roles got swapped — rewrite it.",
  'Example of GOOD: "Hi Sunny — I\'m putting a band together and I hear you play bass. What would you',
  'want our first setlist to sound like?"',
  'Example of BAD (never do this): "You\'re starting a band and Sunny plays bass — ask her about your',
  'first setlist."',
  "Example of BAD (the trap): a candidate's profile proudly lists the SENDER's novel, because that",
  'candidate designed its cover. "What style did you have in mind for your novel?" is WRONG — the',
  'SENDER wrote the novel, so it is "my novel"; only the cover is "your" work.',
  "Each ≤ 280 chars, concrete, grounded in both profiles, and different from one another. Return fewer",
  "(or an empty list) when you can't ground a good one; never pad.",
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
          icebreakers: {
            type: "array",
            items: { type: "string" },
            description:
              "Up to 3 short (≤ 280 chars) concrete conversation starters the target can open with. Grounded in both profiles; never a restatement of the reasoning.",
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
  icebreakers?: unknown;
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

/** EVENT/ABOUT/TOPICS header shared by both batch shapes; empty lines dropped. */
function eventBlock(event: EventContextForScoring): string[] {
  return [
    `EVENT: ${event.title}`,
    event.summary ? `ABOUT: ${event.summary}` : "",
    event.hashtags.length ? `TOPICS: ${event.hashtags.join(", ")}` : "",
  ].filter(Boolean);
}

/**
 * The forward-batch user block. Exported (rather than inlined in scoreBatch) so
 * benchmarks/matching/icebreaker-run.mjs can assert byte-for-byte that the block
 * it sends is the block production sends — the ownership/role lines below are part
 * of the attribution fix, so a benchmark that reconstructed them by hand would
 * silently drift from what ships.
 *
 * `ordered` must already be in the order the numbering should use: `index` in the
 * response is 1-based into this array.
 */
export function buildBatchUserBlock(
  event: EventContextForScoring,
  target: AiProfile,
  targetName: string | undefined,
  ordered: readonly BatchCandidate[],
): string {
  return [
    ...eventBlock(event),
    "",
    // Ownership stated next to the blocks, not only in the system prompt: the
    // observed failure (prod 2026-07-24) was attribute theft — the target's own
    // novel, app and code handed back to them as the candidate's — and it happens
    // right here, where two same-shaped profiles sit adjacent. Said on its own
    // line so the `TARGET ATTENDEE:` / `--- CANDIDATE n ---` delimiters keep their
    // exact shape: tests and the benchmark harness parse them.
    //
    // The provenance sentence is the 2026-07-25 addition. A possessive rule cannot
    // settle the case that actually broke: the candidate's own bio led with the
    // TARGET's book as their "hot project" (they had done its artwork), so the same
    // artifact sat in both blocks and the model resolved the tie the wrong way —
    // handing the reader their own novel and courses as the candidate's. Provenance
    // has to be asserted structurally, from which block introduces a thing as its
    // owner's, because the profile text alone is genuinely ambiguous.
    "Everything under TARGET ATTENDEE belongs to the target. Everything under a CANDIDATE heading",
    "belongs to that candidate. A candidate's profile may mention something the TARGET made — they",
    "read it, funded it, or worked on it — and that never makes it theirs. Never credit one person",
    "with the other's work.",
    "",
    "TARGET ATTENDEE:",
    profileText(target, targetName),
    // Role labels sit physically next to the data they bind, because the icebreaker
    // failure was a wholesale role swap (the reader written as the candidate's
    // profession), not just a slipped possessive.
    '(The attendee above is the SENDER of every icebreaker below: what is listed for them is "my".)',
    "",
    "CANDIDATES:",
    '(Each candidate is the RECIPIENT of the icebreakers in their own entry: only what is listed',
    'under their heading is "your".)',
    ...ordered.map((c, i) => [`--- CANDIDATE ${i + 1} ---`, profileText(c.profile, c.name)].join("\n")),
  ].join("\n");
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
  signal?: AbortSignal,
): Promise<BatchScoreResult> {
  const scores = new Map<string, DirectedScore>();
  if (candidates.length === 0) return { scores, missing: [] };

  // Shuffle to spread position bias; `index` (1-based) maps back to the candidate.
  const ordered = shuffle(candidates, rng);
  const user = buildBatchUserBlock(event, target, targetName, ordered);

  const { value } = await llm.completeStructured<{ matches?: RawBatchMatch[] }>({
    system: BATCH_SYSTEM_PROMPT + languageInstruction(event.lang),
    user,
    schema: BATCH_SCORE_SCHEMA,
    schemaName: "batch_score",
    model,
    temperature: 0.3,
    validate: (raw) => batchScoreResponseSchema.parse(raw) as { matches?: RawBatchMatch[] },
    signal,
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
    const icebreakers = normalizeIcebreakers(m.icebreakers);
    scores.set(cand.id, {
      score: normalizeScore(m.score),
      similarity: normalizeScore(m.similarity),
      complementarity: normalizeScore(m.complementarity),
      reasoning: m.reasoning_for_target,
      ...(icebreakers ? { icebreakers } : {}),
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
  "icebreakers — up to THREE opening MESSAGES THIS target can send the shared person. The app pastes",
  "the FIRST one straight into a direct-message box addressed to the shared person, so it must be",
  "sendable as-is, with no editing.",
  "WHO IS WHO. This is the most important rule. Compared with the field above only the PRONOUNS",
  "change — the two people keep their roles, they never swap:",
  ' • SENDER = THIS target. They are typing, so first person ("I"/"my") is always them. Everything',
  "   under this target's own heading — their book, app, courses, company, job, skills — is the",
  '   SENDER\'s own and is "my", NEVER "your".',
  ' • RECIPIENT = the SHARED person. Second person ("you"/"your") is always them. Only what appears',
  '   in the SHARED PERSON block may be called "your".',
  // The 2026-07-25 addition. Everything else in this block was already true of the
  // deployed prompt and it still inverted roles wholesale at a live event: the
  // reader was handed their own album as "tvoj projekt". The forward prompt, whose
  // rules are the same sentences with the roles mirrored, never does this — the one
  // structural difference is that ITS first-printed person is the SENDER while this
  // shape's is the RECIPIENT. So the failure looks like the model taking whoever is
  // printed first and under their own heading as the one speaking. That is what
  // this bullet contradicts by name, and why the user block now states the writer
  // of each entry on the line under that entry's profile.
  " • BLOCK ORDER IS NOT ROLE ORDER. The shared person is printed FIRST only because they are the",
  "   same person in every entry. Printed first does not mean speaking. The writer of entry n is",
  "   TARGET n — never the shared person — and the line directly under each target's profile says",
  '   so ("Entry n is written BY the TARGET n profile above, TO …"). If the order the blocks are',
  "   printed in ever seems to disagree with that line, the line is right.",
  " • Never hand one person's work to the other. If the SENDER wrote a novel, never ask the",
  '   RECIPIENT about "your novel" — the SENDER wrote it, so it is "my novel". If the RECIPIENT',
  '   built a tool, never call it "my tool". The SENDER does not borrow the RECIPIENT\'s job,',
  "   profession or skills either.",
  " • WHOSE IS IT, when both profiles name the same thing: the shared person's profile may mention",
  "   something the SENDER made — they read it, funded it, drew its cover, did its branding, or list",
  '   it as a "hot project" they worked on. A mention does NOT transfer authorship. Each target\'s own',
  "   block is the authority on what that SENDER made: anything it presents as theirs stays \"my\",",
  "   however prominently the shared person lists it.",
  '   MECHANICAL CHECK before you write "your <name>" (or that phrase in another language): find that',
  "   name in BOTH blocks. If it appears in THIS target's own block at all, the phrase is FORBIDDEN —",
  '   it is the SENDER\'s, so write "my <name>". Only a name that appears solely in the SHARED PERSON',
  '   block may take "your". Their contribution to it ("your cover", "your branding") still takes',
  "   second person; the thing itself does not.",
  " • Write a message, not a briefing. Describing the two of them to a third party (\"You're a",
  '   cypherpunk and she studies X — ask her about Y") cannot be sent to anyone; do not do it.',
  " • This is a rule about ROLES, not about the English words. It holds in whatever language you",
  "   write in: use that language's own first-person possessive forms for the SENDER and its",
  "   second-person possessive forms for the RECIPIENT. The forms change; the owner never does.",
  "Re-read each icebreaker before returning it: every second-person possessive must point at",
  "something from the SHARED PERSON block, every first-person one at something from THIS target's",
  "own block. If one does not, the roles got swapped — rewrite it.",
  'Example of GOOD: "Hi Sunny — I\'m putting a band together and I hear you play bass. What would you',
  'want our first setlist to sound like?"',
  'Example of BAD (never do this): "You\'re starting a band and Sunny plays bass — ask her about your',
  'first setlist."',
  "Example of BAD (the trap): the shared person's profile proudly lists the SENDER's novel, because",
  'they designed its cover. "What style did you have in mind for your novel?" is WRONG — the SENDER',
  'wrote the novel, so it is "my novel"; only the cover is "your" work.',
  "Each ≤ 280 chars, concrete, grounded in both profiles, and different from one another. Return fewer",
  "(or none) rather than pad.",
  "",
  "Return one entry per target, using the target's number as `index`. Score EVERY target exactly once.",
].join("\n");

/**
 * The reverse-batch user block. Exported for the same reason as
 * buildBatchUserBlock: the benchmark must send production's bytes.
 *
 * This is the shape that inverts. The forward block and this one carry the same
 * ownership rules, word for word with the roles mirrored, and the benchmark scores
 * the forward one at 0 attribution errors in English AND Slovak — including on a
 * Slovak replica of the exact pair that broke — while this one keeps producing them
 * (1/171 with the pre-2026-07-25 wording, 1/182 with the current wording; the
 * rewording changed nothing measurable). The one thing that differs is print order:
 * forward prints the SENDER first under its own heading, this prints the RECIPIENT
 * first and leaves each SENDER as item n of a numbered list. The failures read
 * exactly like a model that took the first-printed person as the one speaking.
 *
 * Two devices against that, because the shared person cannot simply be moved below
 * the list (there are K senders and one recipient, and the recipient has to be
 * stated once for the batch to be worth batching):
 *
 *  1. A writer directory ABOVE the shared person's block, one line per entry, the
 *     writer named FIRST — so the first people the model reads about are the
 *     senders, in the role they actually have, before the recipient's heading can
 *     claim the protagonist slot.
 *  2. A binding line under EVERY target's profile, naming that target as the writer
 *     of that entry. This mirrors the forward block, where the SENDER line sits
 *     directly under the SENDER's profile; here it has to be repeated per entry
 *     because every entry has a different sender.
 *
 * Constraints on this text that are not obvious from reading it: the
 * `SHARED PERSON (the one each target below would meet):` heading must be
 * immediately followed by the shared profile, `TARGET ATTENDEES:` must appear
 * exactly once and after it, and each `--- TARGET n ---` must be immediately
 * followed by that target's profile — the coordinator test's fake LLM slices the
 * user block on precisely those three landmarks to decide who it was asked about.
 */
export function buildReverseBatchUserBlock(
  event: EventContextForScoring,
  shared: AiProfile,
  sharedName: string | undefined,
  ordered: readonly BatchCandidate[],
): string {
  // Names when we have them, positional labels when we do not (pre-migration rows
  // and profiles without a display name): the directory is useless if half its
  // lines say "undefined".
  const recipient = sharedName?.trim() || "the shared person";
  const writer = (c: BatchCandidate, i: number) => c.name?.trim() || `TARGET ${i + 1}`;
  return [
    ...eventBlock(event),
    "",
    // Ownership + provenance alongside the blocks — see the note in
    // buildBatchUserBlock; the reverse shape has the same tie to break, with the
    // roles mirrored (each target is a SENDER, the shared person the RECIPIENT).
    "Everything under SHARED PERSON belongs to that person. Everything under a TARGET heading belongs",
    "to that target. The shared person's profile may mention something a TARGET made — they read it,",
    "funded it, or worked on it — and that never makes it theirs. Never credit one person with the",
    "other's work.",
    "",
    "WHO WRITES EACH ENTRY (the writer is named first):",
    ...ordered.map((c, i) => `  entry ${i + 1}: ${writer(c, i)} (TARGET ${i + 1} below) writes to ${recipient}`),
    `${recipient} writes nothing and is only read — being printed first does not make them the writer.`,
    "",
    "SHARED PERSON (the one each target below would meet):",
    profileText(shared, sharedName),
    '(The shared person is the RECIPIENT of every icebreaker below: what is listed for them is "your".)',
    "",
    "TARGET ATTENDEES: one numbered block per WRITER — the icebreakers in entry n are typed by TARGET n.",
    '(Each target is the SENDER of the icebreakers in their own entry: only what is listed under',
    'their heading is "my".)',
    ...ordered.map((c, i) =>
      [
        `--- TARGET ${i + 1} ---`,
        profileText(c.profile, c.name),
        `(Entry ${i + 1} is written BY the TARGET ${i + 1} profile above, TO ${recipient}: in entry ${i + 1}` +
          ` "my" = ${writer(c, i)}, "your" = ${recipient}.)`,
      ].join("\n"),
    ),
  ].join("\n");
}

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
  signal?: AbortSignal,
): Promise<BatchScoreResult> {
  const scores = new Map<string, DirectedScore>();
  if (targets.length === 0) return { scores, missing: [] };

  const ordered = shuffle(targets, rng);
  const user = buildReverseBatchUserBlock(event, shared, sharedName, ordered);

  const { value } = await llm.completeStructured<{ matches?: RawBatchMatch[] }>({
    system: REVERSE_BATCH_SYSTEM_PROMPT + languageInstruction(event.lang),
    user,
    schema: BATCH_SCORE_SCHEMA,
    schemaName: "reverse_batch_score",
    model,
    temperature: 0.3,
    validate: (raw) => batchScoreResponseSchema.parse(raw) as { matches?: RawBatchMatch[] },
    signal,
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
    const icebreakers = normalizeIcebreakers(m.icebreakers);
    scores.set(tgt.id, {
      score: normalizeScore(m.score),
      similarity: normalizeScore(m.similarity),
      complementarity: normalizeScore(m.complementarity),
      reasoning: m.reasoning_for_target,
      ...(icebreakers ? { icebreakers } : {}),
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
