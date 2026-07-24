/**
 * Icebreaker attribution benchmark — does the prompt keep straight who is
 * writing to whom?
 *
 * Motivation: benchmarks/matching measured SCORES (recall@k, separation) and
 * blind-judged `reasoning`, but icebreakers were added afterwards under NIP §6.2
 * and were never measured at all. They then shipped a class of failure a human
 * spots instantly and no existing metric could see — the reader's own book, app
 * and code handed to them as the other person's work.
 *
 * The trick that makes this cheap: every persona owns an invented artifact
 * (icebreaker-fixture.mjs), so "whose is this?" is decidable by string match
 * instead of by a judge. See icebreaker-grade.mjs.
 *
 * The IB1 variant is not a copy of the production prompt — it IS the production
 * prompt, imported from the built coordinator, with a startup assertion that the
 * spliced skeleton reproduces it byte-for-byte. A benchmark that drifts from what
 * ships measures nothing.
 *
 *   node icebreaker-run.mjs [model] [K]
 *   VENICE_API_KEY must be set. Results → results/ICEBREAKER_<model>.json
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { complete, pool, parseJsonLoose } from "./lib.mjs";
import { EVENT } from "./personas.mjs";
import { buildCases } from "./icebreaker-fixture.mjs";
import { gradeIcebreaker, summarize } from "./icebreaker-grade.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { BATCH_SYSTEM_PROMPT } = await import(
  join(here, "../../packages/coordinator/dist/matching/scoring.js")
);

const MODEL = process.argv[2] || "zai-org-glm-5-2";
const K = Number(process.argv[3] || 4);

// ── Prompt variants ──────────────────────────────────────────────────────────
// The block as it shipped BEFORE the fix: it names no speaker and no listener,
// which is the entire defect — "you" had two possible referents in a field whose
// sibling field binds "you" to the other one.
const IB0_BLOCK = [
  "icebreakers — up to THREE short conversation starters (each ≤ 280 chars) the target can open",
  "with when they meet this candidate. Each is a CONCRETE opening line or question grounded in both",
  "people's actual details — never a restatement of the reasoning or an analytical remark. Return",
  "fewer (or an empty list) when you can't ground a good one; never pad.",
].join("\n");

const START = "icebreakers —";
const END = "\n\nReturn one entry per candidate";

function spliceIcebreakerBlock(prompt, block) {
  const i = prompt.indexOf(START);
  const j = prompt.indexOf(END);
  if (i === -1 || j === -1 || j < i) throw new Error("could not locate the icebreaker block");
  return prompt.slice(0, i) + block + prompt.slice(j);
}

const IB1_SYSTEM = BATCH_SYSTEM_PROMPT;
const IB0_SYSTEM = spliceIcebreakerBlock(BATCH_SYSTEM_PROMPT, IB0_BLOCK);
// Self-check: splicing the CURRENT block back in must reproduce the shipped
// prompt exactly, or the two variants differ by more than the thing under test.
{
  const currentBlock = BATCH_SYSTEM_PROMPT.slice(
    BATCH_SYSTEM_PROMPT.indexOf(START),
    BATCH_SYSTEM_PROMPT.indexOf(END),
  );
  const rebuilt = spliceIcebreakerBlock(BATCH_SYSTEM_PROMPT, currentBlock);
  if (rebuilt !== BATCH_SYSTEM_PROMPT) throw new Error("splice self-check failed");
  if (IB0_SYSTEM === IB1_SYSTEM) throw new Error("variants are identical — is dist stale?");
}

// The ownership lines in the user block are part of the fix, so IB0 must not get
// them (mirrors scoring.ts's scoreBatch, minus those two lines).
const OWNERSHIP = [
  "Everything under TARGET ATTENDEE belongs to the target. Everything under a CANDIDATE heading",
  "belongs to that candidate. Never credit one person with the other's work.",
  "",
];

function profileBlock(p, name) {
  return [
    `Name: ${name}`,
    `Summary: ${p.summary}`,
    `Skills: ${p.skills.join(", ")}`,
    `Interests: ${p.interests.join(", ")}`,
    `Offers: ${p.offers.join(", ")}`,
    `Seeks: ${p.seeks.join(", ")}`,
  ].join("\n");
}

function userBlock(target, candidates, withOwnership) {
  return [
    `EVENT: ${EVENT.title}`,
    EVENT.summary ? `ABOUT: ${EVENT.summary}` : "",
    EVENT.hashtags?.length ? `TOPICS: ${EVENT.hashtags.join(", ")}` : "",
    "",
    ...(withOwnership ? OWNERSHIP : []),
    "TARGET ATTENDEE:",
    profileBlock(target.ai_profile, target.name),
    "",
    "CANDIDATES:",
    ...candidates.map((c, i) =>
      [`--- CANDIDATE ${i + 1} ---`, profileBlock(c.ai_profile, c.name)].join("\n"),
    ),
  ]
    .filter((l) => l !== "")
    .join("\n");
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

async function runVariant(label, system, withOwnership) {
  const cases = buildCases(K);
  const rows = [];
  let failed = 0;
  await pool(
    cases,
    async ({ target, candidates }) => {
      let value;
      try {
        const { content } = await complete({
          model: MODEL,
          system,
          user: userBlock(target, candidates, withOwnership),
          schema: SCHEMA,
          schemaName: "batch_score",
          temperature: 0.3,
        });
        value = parseJsonLoose(content);
      } catch (e) {
        failed++;
        console.error(`  [${label}] ${target.id} call failed: ${e.message}`);
        return;
      }
      for (const m of value?.matches ?? []) {
        const cand = candidates[Number(m.index) - 1];
        if (!cand || !Array.isArray(m.icebreakers)) continue;
        for (const text of m.icebreakers) {
          if (typeof text !== "string" || !text.trim()) continue;
          rows.push({
            variant: label,
            target: target.id,
            candidate: cand.id,
            text,
            violations: gradeIcebreaker(text, target, cand),
          });
        }
      }
    },
    4,
  );
  return { label, failed, rows, summary: summarize(rows) };
}

console.log(`model=${MODEL} K=${K} — ${buildCases(K).length} calls per variant\n`);
const before = await runVariant("IB0-before", IB0_SYSTEM, false);
const after = await runVariant("IB1-shipped", IB1_SYSTEM, true);

const fmt = (r) =>
  `${r.label.padEnd(12)} n=${String(r.summary.total).padStart(3)}  ` +
  `attribution-errors ${String(r.summary.attributionErrors).padStart(3)} (${r.summary.attributionErrorPct}%)  ` +
  `[theft ${r.summary.theft} / false-claim ${r.summary.falseClaim}]  ` +
  `briefing ${r.summary.briefing} (${r.summary.briefingPct}%)  ` +
  `clean ${r.summary.cleanPct}%`;

console.log("\n" + fmt(before));
console.log(fmt(after));

mkdirSync(join(here, "results"), { recursive: true });
const out = join(here, "results", `ICEBREAKER_${MODEL}_K${K}.json`);
writeFileSync(out, JSON.stringify({ model: MODEL, k: K, before, after }, null, 2));
console.log(`\nwrote ${out}`);

// Sample of what actually went wrong, so a regression is diagnosable not just countable.
for (const r of [before, after]) {
  const bad = r.rows.filter((x) => x.violations.length);
  if (!bad.length) continue;
  console.log(`\n--- ${r.label}: ${bad.length} flagged, first 5 ---`);
  for (const b of bad.slice(0, 5)) console.log(`  [${b.violations.join(",")}] ${b.text}`);
}
