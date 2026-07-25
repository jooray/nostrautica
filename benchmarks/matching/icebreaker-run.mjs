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
 * Variants are not copies of the production prompt — IB2 IS the production
 * prompt, imported from the built coordinator, and the two controls are built by
 * splicing the historical blocks back into it, with startup assertions that the
 * splice reproduces the shipped text byte-for-byte and that the user block this
 * harness sends is the one production sends. A benchmark that drifts from what
 * ships measures nothing.
 *
 *   node icebreaker-run.mjs [model] [K] [langs] [variants]
 *   e.g. node icebreaker-run.mjs deepseek-v4-flash 4 en,sk IB1,IB2
 *   VENICE_API_KEY must be set. Rebuild dist first:
 *     pnpm --filter @nostrautica/coordinator build
 *   Results → results/ICEBREAKER_<model>_K<k>_<langs>.json
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { complete, pool, parseJsonLoose } from "./lib.mjs";
import { EVENT } from "./personas.mjs";
import {
  buildCases,
  buildSharedArtifactCases,
  buildProdReplicaCases,
  buildReverseCases,
} from "./icebreaker-fixture.mjs";
import { gradeIcebreaker, mentionsEntity, summarize } from "./icebreaker-grade.mjs";

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

const START = "icebreakers —";
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

const REV_END = "\n\nReturn one entry per target";

function spliceReverseBlock(prompt, block) {
  const i = prompt.indexOf(START);
  const j = prompt.indexOf(REV_END);
  if (i === -1 || j === -1 || j < i) throw new Error("could not locate the reverse icebreaker block");
  return prompt.slice(0, i) + block + prompt.slice(j);
}

{
  const currentBlock = REVERSE_BATCH_SYSTEM_PROMPT.slice(
    REVERSE_BATCH_SYSTEM_PROMPT.indexOf(START),
    REVERSE_BATCH_SYSTEM_PROMPT.indexOf(REV_END),
  );
  if (spliceReverseBlock(REVERSE_BATCH_SYSTEM_PROMPT, currentBlock) !== REVERSE_BATCH_SYSTEM_PROMPT) {
    throw new Error("reverse splice self-check failed");
  }
  if (currentBlock === R1_BLOCK) throw new Error("live reverse block equals the control — is dist stale?");
}

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

function replaceOnce(text, needle, replacement) {
  if (!text.includes(needle)) throw new Error(`user-block anchor missing: ${needle.slice(0, 48)}…`);
  return text.replace(needle, replacement);
}

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
    user: (u) =>
      replaceOnce(replaceOnce(replaceOnce(u, REV_NEW_PREAMBLE, REV_R1_PREAMBLE), REV_RECIPIENT_LINE, ""), REV_SENDER_LINES, ""),
  },
  R2: {
    label: "R2-new",
    shape: "reverse",
    system: (lang) => REVERSE_BATCH_SYSTEM_PROMPT + languageInstruction(lang),
    user: (u) => u,
  },
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
    for (const key of ["R1", "R2"]) VARIANTS[key].user(live);
    if (VARIANTS.R1.user(live) === live) throw new Error("R1 user block is identical to the live one");
  }
}

async function runVariant(key, lang) {
  const v = VARIANTS[key];
  const system = v.system(lang);
  const rows = [];
  let failed = 0;
  const reverse = v.shape === "reverse";
  await pool(
    CASES.filter((c) => isReverse(c) === reverse),
    async (kase) => {
      const { bucket } = kase;
      // Forward: one SENDER (the target) + K RECIPIENTs. Reverse: one RECIPIENT
      // (the shared person) + K SENDERs. `index` numbers the LIST either way, so
      // the list is what varies and the single person is fixed.
      const listed = reverse ? kase.targets : kase.candidates;
      const fixed = reverse ? kase.shared : kase.target;
      let value;
      try {
        const { content } = await complete({
          model: MODEL,
          system,
          user: v.user(
            reverse ? liveReverseUserBlock(kase.shared, kase.targets) : liveUserBlock(kase.target, kase.candidates),
          ),
          schema: SCHEMA,
          schemaName: reverse ? "reverse_batch_score" : "batch_score",
          temperature: 0.3,
        });
        value = parseJsonLoose(content);
      } catch (e) {
        failed++;
        console.error(`  [${v.label}/${lang}] ${fixed.id} call failed: ${e.message}`);
        return;
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
    4,
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
  `model=${MODEL} K=${K} langs=${LANGS.join(",")} variants=${WANTED.join(",")} — ` +
    `${CASES.length} calls per variant per language ` +
    `(buckets: ${[...new Set(CASES.map((c) => c.bucket))].join(", ")})\n`,
);

const runs = [];
for (const lang of LANGS) {
  for (const key of WANTED) {
    if (!VARIANTS[key]) throw new Error(`unknown variant ${key} (have ${Object.keys(VARIANTS)})`);
    console.log(`→ ${VARIANTS[key].label} / ${lang}`);
    runs.push(await runVariant(key, lang));
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

mkdirSync(join(here, "results"), { recursive: true });
// Language in the filename so a per-language run never clobbers the 2026-07-24
// English-only result the README's first numbers came from.
// Variants in the filename too: a reverse-shape run and a forward-shape run of
// the same model/langs are different experiments and must not clobber each other.
const out = join(
  here,
  "results",
  `ICEBREAKER_${MODEL}_K${K}_${LANGS.join("-")}_${WANTED.join("-")}.json`,
);
writeFileSync(out, JSON.stringify({ model: MODEL, k: K, langs: LANGS, runs }, null, 2));
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
