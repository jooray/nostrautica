/**
 * Icebreaker attribution benchmark — does the prompt keep straight who is
 * writing to whom, in the language the event is actually held in?
 *
 * Motivation: benchmarks/matching measured SCORES (recall@k, separation) and
 * blind-judged `reasoning`, but icebreakers were added afterwards under NIP §6.2
 * and were never measured at all. They then shipped a class of failure a human
 * spots instantly and no existing metric could see — the reader's own book, app
 * and code handed to them as the other person's work.
 *
 * Then the fix for that failure benchmarked at 0% attribution errors and failed
 * in production anyway, because this harness only ever ran in ENGLISH while the
 * event was Slovak: the WHO IS WHO rule is necessarily written with English
 * pronoun tokens, and nothing here checked that the binding survives môj/tvoj.
 * So the output language is now a parameter and every variant runs per language,
 * exactly as production builds it (system prompt + languageInstruction(lang)).
 *
 * The trick that makes this cheap: every persona owns an invented artifact
 * (icebreaker-fixture.mjs), so "whose is this?" is decidable by string match
 * instead of by a judge. See icebreaker-grade.mjs.
 *
 * Variants are not copies of the production prompt — IB2 (forward) and R3
 * (reverse) ARE the production prompts, imported from the built coordinator, and
 * every control is built by splicing the historical blocks back into them, with
 * startup assertions that the splice reproduces the shipped text byte-for-byte and
 * that the user block this harness sends is the one production sends. A benchmark
 * that drifts from what ships measures nothing. The reverse variants live in
 * reverse-variants.mjs because reverse-score-run.mjs sends the same two prompts.
 *
 *   node icebreaker-run.mjs [model] [K] [langs] [variants] [buckets]
 *   e.g. node icebreaker-run.mjs deepseek-v4-flash 4 en,sk IB1,IB2
 *   REPEATS=n re-asks every case n times (sample size; see runVariant), CONC=n sets
 *   calls in flight.
 *   VENICE_API_KEY must be set. Rebuild dist first:
 *     pnpm --filter @nostrautica/coordinator build
 *   Results → results/ICEBREAKER_<model>_K<k>_<langs>_<variants>.json
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { complete, pool, parseJsonLoose, cacheKey, readCache, writeCache } from "./lib.mjs";
import { EVENT } from "./personas.mjs";
import {
  buildCases,
  buildSharedArtifactCases,
  buildProdReplicaCases,
  buildReverseCases,
  buildReverseDenseCases,
} from "./icebreaker-fixture.mjs";
import { gradeIcebreaker, mentionsEntity, summarize } from "./icebreaker-grade.mjs";
// The reverse variants live in their own module because reverse-score-run.mjs sends
// the same two prompts to answer the other half of the question (did the scores
// move). Two copies of a control are two different controls the day one is edited.
import {
  REVERSE_VARIANTS,
  ROLE_FIELDS,
  START,
  replaceOnce,
  spliceReverseBlock,
  stripReverseDirection,
} from "./reverse-variants.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const {
  BATCH_SYSTEM_PROMPT,
  REVERSE_BATCH_SYSTEM_PROMPT,
  buildBatchUserBlock,
  buildReverseBatchUserBlock,
  languageInstruction,
} = await import(join(here, "../../packages/coordinator/dist/matching/scoring.js"));

const MODEL = process.argv[2] || "zai-org-glm-5-2";
const K = Number(process.argv[3] || 4);
const LANGS = (process.argv[4] || "en").split(",").map((s) => s.trim()).filter(Boolean);
const WANTED = (process.argv[5] || "IB1,IB2").split(",").map((s) => s.trim()).filter(Boolean);
// Optional bucket filter. Probing one bucket costs a handful of calls, which is
// how you find out whether a fixture can reproduce a failure at all before paying
// for a full run: a benchmark where the CONTROL also scores 0% proves nothing.
const BUCKETS = (process.argv[6] || "").split(",").map((s) => s.trim()).filter(Boolean);
/** How many times to re-ask each case (see runVariant) and how many calls in flight. */
const REPEATS = Number(process.env.REPEATS || 1);
// 16, not the old 4. Concurrency here cannot affect any number this benchmark
// reports, which is the only reason it is safe to raise: every call is an
// independent (fixed person, fixed list) batch, the case list is RNG-free, entries
// are matched back by the `index` the model returns rather than by arrival, and
// every metric is a count over rows. The one thing that does change is the ORDER
// rows land in the saved file, which nothing reads. A K=10 run at 4 took ~30s per
// call wall-clock and over an hour per language; that is what made the first
// attempt run into its runner's 60-minute limit.
const CONC = Number(process.env.CONC || 16);
/** Per-call cache, so a killed or interrupted run resumes instead of re-billing. */
const CACHE_DIR = "./cache/icebreaker";

// ── system-prompt variants ───────────────────────────────────────────────────
// IB0: the block as it shipped before 2026-07-24 — it names no speaker and no
// listener, which is the whole defect: "you" had two possible referents in a
// field whose sibling field binds "you" to the other one.
const IB0_BLOCK = [
  "icebreakers — up to THREE short conversation starters (each ≤ 280 chars) the target can open",
  "with when they meet this candidate. Each is a CONCRETE opening line or question grounded in both",
  "people's actual details — never a restatement of the reasoning or an analytical remark. Return",
  "fewer (or an empty list) when you can't ground a good one; never pad.",
].join("\n");

// IB1: the block deployed 2026-07-24 — the one that benchmarked at 0% in English
// and then inverted every icebreaker for one candidate at a live Slovak event.
// Kept verbatim as the control this change has to beat.
const IB1_BLOCK = [
  "icebreakers — up to THREE opening MESSAGES the target can send this candidate. The app pastes the",
  "FIRST one straight into a direct-message box addressed to this candidate, so it must be sendable",
  "as-is, with no editing.",
  "WHO IS WHO. This is the most important rule and it INVERTS the field above:",
  ' • The speaker is the TARGET. "I"/"my" = the target. Everything in the TARGET ATTENDEE block —',
  '   their book, project, company, job, skills — belongs to the target, so it is "my", NEVER "your".',
  ' • The listener is THIS candidate. "you"/"your" = the candidate. Only details from THIS',
  '   candidate\'s own block may be called "your".',
  " • Never hand one person's work to the other. If the TARGET wrote a novel, do not ask the candidate",
  '   about "your novel" — that novel is the target\'s, so it is "my novel".',
  " • Write a message, not a briefing. Describing the two of them to a third party (\"You're a",
  '   cypherpunk and she studies X — ask her about Y") cannot be sent to anyone; do not do it.',
  'Example of GOOD: "Hi Sunny — I\'m putting a band together and I hear you play bass. What would you',
  'want our first setlist to sound like?"',
  'Example of BAD (never do this): "You\'re starting a band and Sunny plays bass — ask her about your',
  'first setlist."',
  "Each ≤ 280 chars, concrete, grounded in both profiles, and different from one another. Return fewer",
  "(or an empty list) when you can't ground a good one; never pad.",
].join("\n");

/** START (shared with the reverse variants) is where the icebreaker block begins. */
const END = "\n\nReturn one entry per candidate";

function spliceIcebreakerBlock(prompt, block) {
  const i = prompt.indexOf(START);
  const j = prompt.indexOf(END);
  if (i === -1 || j === -1 || j < i) throw new Error("could not locate the icebreaker block");
  return prompt.slice(0, i) + block + prompt.slice(j);
}

// Self-check: splicing the CURRENT block back in must reproduce the shipped
// prompt exactly, or the variants differ by more than the thing under test.
{
  const currentBlock = BATCH_SYSTEM_PROMPT.slice(
    BATCH_SYSTEM_PROMPT.indexOf(START),
    BATCH_SYSTEM_PROMPT.indexOf(END),
  );
  const rebuilt = spliceIcebreakerBlock(BATCH_SYSTEM_PROMPT, currentBlock);
  if (rebuilt !== BATCH_SYSTEM_PROMPT) throw new Error("splice self-check failed");
  if (currentBlock === IB1_BLOCK || currentBlock === IB0_BLOCK) {
    throw new Error("the live block equals a control — is dist stale? (pnpm --filter @nostrautica/coordinator build)");
  }
}

// R1: the reverse block deployed 2026-07-24. Never benchmarked until now — the
// forward harness could not see it, and this is the shape that prints the
// RECIPIENT first (see buildReverseCases).
const R1_BLOCK = [
  "icebreakers — up to THREE opening MESSAGES THIS target can send the shared person. The app pastes",
  "the FIRST one straight into a direct-message box addressed to the shared person, so it must be",
  "sendable as-is, with no editing.",
  "WHO IS WHO. This is the most important rule and it INVERTS the field above:",
  ' • The speaker is THIS target. "I"/"my" = this target. Everything in this target\'s own block —',
  '   their book, project, company, job, skills — belongs to them, so it is "my", NEVER "your".',
  ' • The listener is the SHARED person. "you"/"your" = the shared person. Only details from the',
  '   SHARED PERSON\'s block may be called "your".',
  " • Never hand one person's work to the other. If the target wrote a novel, do not ask the shared",
  '   person about "your novel" — that novel is the target\'s, so it is "my novel".',
  " • Write a message, not a briefing. Describing the two of them to a third party (\"You're a",
  '   cypherpunk and she studies X — ask her about Y") cannot be sent to anyone; do not do it.',
  'Example of GOOD: "Hi Sunny — I\'m putting a band together and I hear you play bass. What would you',
  'want our first setlist to sound like?"',
  'Example of BAD (never do this): "You\'re starting a band and Sunny plays bass — ask her about your',
  'first setlist."',
  "Each ≤ 280 chars, concrete, grounded in both profiles, and different from one another. Return fewer",
  "(or none) rather than pad.",
].join("\n");

// ── user-block variants ──────────────────────────────────────────────────────
// Production builds the user block; this harness must send the SAME bytes, so it
// starts from buildBatchUserBlock() and edits the lines under test back to their
// historical wording. Each anchor is asserted present, so a reworded prompt fails
// loudly here instead of quietly measuring a mixture of two variants.
const NEW_PREAMBLE = [
  "Everything under TARGET ATTENDEE belongs to the target. Everything under a CANDIDATE heading",
  "belongs to that candidate. A candidate's profile may mention something the TARGET made — they",
  "read it, funded it, or worked on it — and that never makes it theirs. Never credit one person",
  "with the other's work.",
].join("\n");
const IB1_PREAMBLE = [
  "Everything under TARGET ATTENDEE belongs to the target. Everything under a CANDIDATE heading",
  "belongs to that candidate. Never credit one person with the other's work.",
].join("\n");
const SENDER_LINE =
  '\n(The attendee above is the SENDER of every icebreaker below: what is listed for them is "my".)';
const RECIPIENT_LINES =
  '\n(Each candidate is the RECIPIENT of the icebreakers in their own entry: only what is listed\nunder their heading is "your".)';

const REV_NEW_PREAMBLE = [
  "Everything under SHARED PERSON belongs to that person. Everything under a TARGET heading belongs",
  "to that target. The shared person's profile may mention something a TARGET made — they read it,",
  "funded it, or worked on it — and that never makes it theirs. Never credit one person with the",
  "other's work.",
].join("\n");
const REV_R1_PREAMBLE = [
  "Everything under SHARED PERSON belongs to that person. Everything under a TARGET heading belongs",
  "to that target. Never credit one person with the other's work.",
].join("\n");
const REV_RECIPIENT_LINE =
  '\n(The shared person is the RECIPIENT of every icebreaker below: what is listed for them is "your".)';
const REV_SENDER_LINES =
  '\n(Each target is the SENDER of the icebreakers in their own entry: only what is listed under\ntheir heading is "my".)';

/** The 2026-07-24 language block — the control's version of languageInstruction. */
const LANG_NAMES = { en: "English", sk: "Slovak", cs: "Czech", de: "German" };
function oldLanguageInstruction(lang) {
  if (lang === "en") return "";
  const name = LANG_NAMES[lang];
  if (!name) throw new Error(`add ${lang} to LANG_NAMES`);
  return [
    "",
    "OUTPUT LANGUAGE:",
    "The attendee profiles below may be written in any language (English profiles at a",
    `${name}-language event are normal). Regardless of the input language, write every`,
    `reasoning string in ${name} (${lang}). All other JSON fields (scores) are unchanged.`,
  ].join("\n");
}

const VARIANTS = {
  // label → { system(lang), user(target, candidates) }
  IB0: {
    label: "IB0-prefix",
    system: (lang) => spliceIcebreakerBlock(BATCH_SYSTEM_PROMPT, IB0_BLOCK) + oldLanguageInstruction(lang),
    user: (u) => replaceOnce(replaceOnce(replaceOnce(u, `${NEW_PREAMBLE}\n\n`, ""), SENDER_LINE, ""), RECIPIENT_LINES, ""),
  },
  IB1: {
    label: "IB1-deployed",
    system: (lang) => spliceIcebreakerBlock(BATCH_SYSTEM_PROMPT, IB1_BLOCK) + oldLanguageInstruction(lang),
    user: (u) => replaceOnce(replaceOnce(replaceOnce(u, NEW_PREAMBLE, IB1_PREAMBLE), SENDER_LINE, ""), RECIPIENT_LINES, ""),
  },
  IB2: {
    label: "IB2-new",
    system: (lang) => BATCH_SYSTEM_PROMPT + languageInstruction(lang),
    user: (u) => u,
  },
  // Reverse shape: one shared RECIPIENT, K SENDERs. Only runs on reverse-* cases.
  R1: {
    label: "R1-deployed",
    shape: "reverse",
    system: (lang) => spliceReverseBlock(REVERSE_BATCH_SYSTEM_PROMPT, R1_BLOCK) + oldLanguageInstruction(lang),
    user: (u) => {
      const old = stripReverseDirection(u);
      return replaceOnce(
        replaceOnce(replaceOnce(old, REV_NEW_PREAMBLE, REV_R1_PREAMBLE), REV_RECIPIENT_LINE, ""),
        REV_SENDER_LINES,
        "",
      );
    },
  },
  // R2 (2026-07-25 roles wording) and R3 (live, block-order restructure) come from
  // reverse-variants.mjs — reverse-score-run.mjs measures the same two prompts.
  ...REVERSE_VARIANTS,
};

// Self-check: the control language block must differ from the live one for a
// non-en language (the language block is part of the fix), and both must name the
// same language, so LANG_NAMES cannot silently drift from languageName().
for (const lang of LANGS) {
  const live = languageInstruction(lang);
  const old = oldLanguageInstruction(lang);
  if (lang === "en") {
    if (live !== "" || old !== "") throw new Error("en must get no language block");
    continue;
  }
  if (live === old) throw new Error(`languageInstruction(${lang}) matches the control — is dist stale?`);
  if (!live.includes(`${LANG_NAMES[lang]} (${lang})`)) {
    throw new Error(`languageInstruction(${lang}) does not name ${LANG_NAMES[lang]}`);
  }
}

const SCHEMA = {
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
          index: { type: "number" },
          similarity: { type: "number" },
          complementarity: { type: "number" },
          score: { type: "number" },
          reasoning_for_target: { type: "string" },
          icebreakers: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const ALL_CASES = [
  ...buildCases(K),
  ...buildSharedArtifactCases(K),
  ...buildProdReplicaCases(K),
  ...buildReverseCases(K),
  // Every entry is the ambiguous case, so the denominator is all trap rather than
  // one trap diluted by k−1 ordinary pairs — see buildReverseDenseCases. Opt-in by
  // bucket: it is a stress test, and pooling it with the sparse buckets would make
  // both numbers mean nothing.
  ...buildReverseDenseCases(K),
];
const CASES = BUCKETS.length ? ALL_CASES.filter((c) => BUCKETS.includes(c.bucket)) : ALL_CASES;
if (CASES.length === 0) throw new Error(`no cases in buckets ${BUCKETS} (have ${[...new Set(ALL_CASES.map((c) => c.bucket))]})`);

/** Production's own builder, so the bytes are production's bytes. */
function liveUserBlock(target, candidates) {
  return buildBatchUserBlock(
    { title: EVENT.title, summary: EVENT.summary, hashtags: EVENT.hashtags ?? [], lang: "en" },
    target.ai_profile,
    target.name,
    candidates.map((c) => ({ id: c.id, profile: c.ai_profile, name: c.name })),
  );
}

/** Production's reverse builder, same parity argument. */
function liveReverseUserBlock(shared, targets) {
  return buildReverseBatchUserBlock(
    { title: EVENT.title, summary: EVENT.summary, hashtags: EVENT.hashtags ?? [], lang: "en" },
    shared.ai_profile,
    shared.name,
    targets.map((t) => ({ id: t.id, profile: t.ai_profile, name: t.name })),
  );
}

/** Reverse variants take reverse cases and vice versa; mixing them is a bug. */
const isReverse = (c) => c.bucket.startsWith("reverse-");

// Self-check the splices once, on a real case of each shape, before spending any
// API budget. A missing anchor here means the prompt was reworded and a control
// would silently become a copy of the live prompt.
{
  const fwd = CASES.find((c) => !isReverse(c));
  if (fwd) {
    const live = liveUserBlock(fwd.target, fwd.candidates);
    for (const key of ["IB0", "IB1", "IB2"]) VARIANTS[key].user(live);
    if (VARIANTS.IB1.user(live) === live) throw new Error("IB1 user block is identical to the live one");
  }
  const rev = CASES.find(isReverse);
  if (rev) {
    const live = liveReverseUserBlock(rev.shared, rev.targets);
    for (const key of ["R1", "R2", "R3", "R4", "R5"]) VARIANTS[key].user(live);
    // R5 moves blocks rather than rewording them, so the assertion is positional.
    const r5 = VARIANTS.R5.user(live);
    if (r5.indexOf("SHARED PERSON (") < r5.indexOf("--- TARGET 1 ---")) throw new Error("R5 did not reorder");
    if (VARIANTS.R5.system("sk") === VARIANTS.R3.system("sk")) throw new Error("R5 system prompt equals R3");
    // R4 is R3 plus the role fields: same user block, different schema and one
    // extra system paragraph. Assert both halves, so a variant that silently lost
    // its schema transform cannot be reported as a second copy of R3.
    if (VARIANTS.R4.user(live) !== live) throw new Error("R4 must send the live user block verbatim");
    if (VARIANTS.R4.system("sk") === VARIANTS.R3.system("sk")) throw new Error("R4 system prompt equals R3");
    const r4 = VARIANTS.R4.schema(SCHEMA).properties.matches.items;
    for (const f of ROLE_FIELDS) {
      if (!r4.required.includes(f)) throw new Error(`R4 schema is missing ${f}`);
      // Alphabetical, NOT the schema's property order: Venice emits keys sorted,
      // so a role field named after "icebreakers" is generated after the openers
      // and steers nothing. This assertion is the whole variant.
      if (!(f < "icebreakers")) throw new Error(`R4 field ${f} sorts after "icebreakers" and would be a no-op`);
    }
    if (VARIANTS.R1.user(live) === live) throw new Error("R1 user block is identical to the live one");
    if (VARIANTS.R2.user(live) === live) throw new Error("R2 user block is identical to the live one");
    // R2 is the control for the restructure, so the two must differ in the SYSTEM
    // prompt too — one bullet — and R3 must be production's own bytes untouched.
    if (VARIANTS.R2.system("sk") === VARIANTS.R3.system("sk")) throw new Error("R2/R3 system prompts are identical");
    if (VARIANTS.R3.user(live) !== live) throw new Error("R3 must send the live user block verbatim");
    // The restored layout itself is asserted inside R2.user (assertStrippedLayout):
    // the strip is pattern-based, and a control that is a half-copy of the thing it
    // controls for is worse than no control.
  }
}

// DRY=1 prints the exact bytes each reverse variant would send and exits, so a
// change to the strip can be read before it is billed. Four grader rounds and two
// prompt rounds in this project were paid for twice for want of this.
if (process.env.DRY) {
  const rev = CASES.find(isReverse);
  if (!rev) throw new Error("DRY needs a reverse case in the selected buckets");
  const live = liveReverseUserBlock(rev.shared, rev.targets);
  for (const key of WANTED) {
    const v = VARIANTS[key];
    if (v.shape !== "reverse") continue;
    console.log(`\n${"=".repeat(78)}\n${v.label} USER BLOCK\n${"=".repeat(78)}\n${v.user(live)}`);
    console.log(`\n--- ${v.label} icebreaker system block ---\n${
      v.system(LANGS[0]).slice(v.system(LANGS[0]).indexOf(START))
    }`);
  }
  process.exit(0);
}

async function runVariant(key, lang) {
  const v = VARIANTS[key];
  const system = v.system(lang);
  // A variant may change the OUTPUT schema as well as the prompt (R4 adds the
  // per-entry role fields). Everything downstream reads `matches[].icebreakers`,
  // which no variant may remove, so grading is unaffected.
  const schema = v.schema ? v.schema(SCHEMA) : SCHEMA;
  const rows = [];
  let failed = 0;
  const reverse = v.shape === "reverse";
  // REPEATS re-asks the same case, which is the only honest way to get the sample
  // size this failure needs: attribution errors run at ~0.5% of openers, so 17
  // trap cases (~170 openers at K=4) cannot tell 0.5% from 0% — see the README's
  // power note. Temperature is 0.3, not 0, so repeats are independent draws rather
  // than a cached answer; the FIXTURE is what stays fixed between variants.
  const work = [];
  for (let rep = 0; rep < REPEATS; rep++) {
    for (const c of CASES.filter((x) => isReverse(x) === reverse)) work.push({ kase: c, rep });
  }
  await pool(
    work,
    async ({ kase, rep }) => {
      const { bucket } = kase;
      // Forward: one SENDER (the target) + K RECIPIENTs. Reverse: one RECIPIENT
      // (the shared person) + K SENDERs. `index` numbers the LIST either way, so
      // the list is what varies and the single person is fixed.
      const listed = reverse ? kase.targets : kase.candidates;
      const fixed = reverse ? kase.shared : kase.target;
      // Cached per call, like run.mjs. This is not a micro-optimisation: a
      // 200-call run takes over an hour and the first attempt at one was killed
      // by its runner 2.5 arms in, losing every response because nothing was on
      // disk yet. With the cache a re-run replays what already happened for free
      // and only pays for what is missing. `rep` is in the key, so repeats stay
      // distinct draws rather than one answer served three times.
      const ck = cacheKey([
        "icebreaker", MODEL, K, v.label, lang, kase.bucket, fixed.id, listed.map((x) => x.id), rep,
      ]);
      let value = readCache(CACHE_DIR, ck);
      if (!value) {
        try {
          const { content } = await complete({
            model: MODEL,
            system,
            user: v.user(
              reverse ? liveReverseUserBlock(kase.shared, kase.targets) : liveUserBlock(kase.target, kase.candidates),
            ),
            schema,
            schemaName: reverse ? "reverse_batch_score" : "batch_score",
            temperature: 0.3,
            // K=10 (production's default batch_size) returns ten entries with three
            // openers each. The 4096 default truncates that mid-JSON, and a truncated
            // response is a lost CASE, not a lost row — parseJsonLoose throws.
            maxTokens: 12000,
          });
          value = parseJsonLoose(content);
        } catch (e) {
          // Deliberately NOT cached: a rate-limit or a truncated response is a
          // transient loss, and caching it would make the gap permanent.
          failed++;
          console.error(`  [${v.label}/${lang}] ${fixed.id} call failed: ${e.message}`);
          return;
        }
        writeCache(CACHE_DIR, ck, value);
      }
      for (const m of value?.matches ?? []) {
        const entry = listed[Number(m.index) - 1];
        if (!entry || !Array.isArray(m.icebreakers)) continue;
        // Grading is always (sender, recipient) — the shape decides which is which.
        const target = reverse ? entry : kase.target;
        const cand = reverse ? kase.shared : entry;
        for (const text of m.icebreakers) {
          if (typeof text !== "string" || !text.trim()) continue;
          rows.push({
            variant: v.label,
            lang,
            bucket,
            rep,
            // The candidate whose own profile advertises the target's artifact —
            // the prod 2026-07-25 shape, reported separately below.
            sharer: cand.sharesTargetArtifact === true,
            target: target.id,
            candidate: cand.id,
            text,
            // Validity guard: an opener that names neither artifact cannot trip
            // the hard checks, so a "clean" rate is only meaningful next to this.
            mentionsTarget: mentionsEntity(text, target.signature.entity),
            mentionsCandidate: mentionsEntity(text, cand.signature.entity),
            violations: gradeIcebreaker(text, target, cand),
          });
        }
      }
    },
    CONC,
  );
  return {
    key,
    label: v.label,
    lang,
    failed,
    rows,
    summary: summarize(rows),
    byBucket: Object.fromEntries(
      [...new Set(rows.map((r) => r.bucket))].map((b) => [b, summarize(rows.filter((r) => r.bucket === b))]),
    ),
    // The cases that must not regress: only the icebreakers addressed to a
    // candidate whose own profile advertises the target's artifact.
    sharerSummary: summarize(rows.filter((r) => r.sharer)),
  };
}

console.log(
  `model=${MODEL} K=${K} langs=${LANGS.join(",")} variants=${WANTED.join(",")} repeats=${REPEATS} — ` +
    `${CASES.length * REPEATS} calls per variant per language ` +
    `(buckets: ${[...new Set(CASES.map((c) => c.bucket))].join(", ")})\n`,
);

mkdirSync(join(here, "results"), { recursive: true });
// Language in the filename so a per-language run never clobbers the 2026-07-24
// English-only result the README's first numbers came from.
// Variants in the filename too: a reverse-shape run and a forward-shape run of
// the same model/langs are different experiments and must not clobber each other.
// The bucket filter belongs in the name too: the same variants over the sparse
// reverse buckets and over reverse-dense are different experiments with very
// different denominators, and without this they would clobber each other.
const BUCKET_TAG = BUCKETS.length === 1 ? `_${BUCKETS[0]}` : "";
const out = join(
  here,
  "results",
  `ICEBREAKER_${MODEL}_K${K}_${LANGS.join("-")}_${WANTED.join("-")}${BUCKET_TAG}${REPEATS > 1 ? `_x${REPEATS}` : ""}.json`,
);

const runs = [];
for (const lang of LANGS) {
  for (const key of WANTED) {
    if (!VARIANTS[key]) throw new Error(`unknown variant ${key} (have ${Object.keys(VARIANTS)})`);
    console.log(`→ ${VARIANTS[key].label} / ${lang}`);
    runs.push(await runVariant(key, lang));
    // Written after EVERY arm, not once at the end. A four-arm run takes over an
    // hour; the first one was killed by its runner during arm three and every
    // response was lost because the file did not exist yet.
    writeFileSync(out, JSON.stringify({ model: MODEL, k: K, langs: LANGS, runs }, null, 2));
  }
}

const fmt = (r, s, tag) =>
  `${(r.label + "/" + r.lang).padEnd(18)} ${tag.padEnd(7)} n=${String(s.total).padStart(3)}  ` +
  `attribution-errors ${String(s.attributionErrors).padStart(3)} (${s.attributionErrorPct}%)  ` +
  `[theft ${s.theft} / false-claim ${s.falseClaim}]  ` +
  `briefing ${s.briefing} (${s.briefingPct}%)  clean ${s.cleanPct}%  ` +
  `names-an-artifact ${s.grounded} (${s.groundedPct}%)`;

console.log("");
for (const r of runs) {
  console.log(fmt(r, r.summary, "all"));
  for (const [bucket, s] of Object.entries(r.byBucket)) console.log(fmt(r, s, bucket));
  console.log(fmt(r, r.sharerSummary, "sharers"));
}

console.log(`\nwrote ${out}`);

// Sample of what actually went wrong, so a regression is diagnosable not just
// countable — and so every flagged row can be eyeballed for grader error, which
// is the only defence against a metric that lies.
for (const r of runs) {
  const bad = r.rows.filter((x) => x.violations.length);
  if (!bad.length) continue;
  console.log(`\n--- ${r.label}/${r.lang}: ${bad.length} flagged, first 6 ---`);
  for (const b of bad.slice(0, 6)) {
    console.log(`  [${b.violations.join(",")}${b.sharer ? ",SHARER" : ""}] ${b.text.slice(0, 190)}`);
  }
}
