/**
 * Model bake-off — one command, one model, one comparable card.
 *
 *   export VENICE_API_KEY=...
 *   node bakeoff.mjs <venice-model-id> [--reps N] [--langs sk,en] [--skip-icebreakers]
 *   node bakeoff-report.mjs                       # the cross-model table
 *
 * Why this exists. The 2026-07 benchmark answered "which model?" by hand: a
 * matrix drive, an evaluator, a separate icebreaker harness, a hand-built blind
 * pack, and a writeup that stitched them together. That is fine once. It is not
 * fine every time a flash-tier model ships — which is now roughly monthly — and
 * the cost of re-deriving the procedure from a README is that the second run is
 * never quite the first run, so the two are not comparable.
 *
 * So the suite is FROZEN here, in code, and every arm of it is a call into the
 * existing scripts rather than a reimplementation: the scoring arms are
 * `run.mjs` (same prompt, same seeds, same eval subset, same cache), the
 * icebreaker arm is `icebreaker-run.mjs` (same fixture, same string-match
 * grader, same production prompt imported from dist). A model added in six
 * months is measured against exactly what deepseek-v4-flash-0731 was measured
 * against, because it runs the same four commands.
 *
 * The suite (all cached; re-running costs nothing for arms already done):
 *   A. BP3 / K=10 / eval subset / seed 1   — scoring quality, matched to history
 *   B. BP3 / K=10 / eval subset / seed 2   — the same, second draw (seed noise)
 *   C. BP3 / K=10 / full 190 pairs / seed 1 — the harder ranking + the cost basis
 *   D. R3 (live prod prompt) / K=10 / reverse-dense / sk+en — attribution errors
 *
 * What it records, per model: every metric evaluate.mjs computes, the
 * deterministic icebreaker grades, tokens/latency/cost from the calls
 * themselves, the request quirks discovered along the way (model-profiles.json),
 * and — the point of the exercise — the raw reasoning and icebreaker TEXT, so a
 * later run can blind-judge this model against models that did not exist yet.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { evalRun } from "./evaluate.mjs";
import { costUsd, priceOf } from "./lib.mjs";
import { modelProfile, snapshotSpec } from "./model-profiles.mjs";
import { promptFingerprint } from "./suite-prompts.mjs";
import { latencyProbe } from "./latency-probe.mjs";
import { detectLanguage } from "./language-adherence.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// ── the frozen suite ─────────────────────────────────────────────────────────
// Changing anything here makes new cards incomparable with old ones. If it must
// change, bump SUITE_VERSION and re-run every model — the report refuses to mix
// versions rather than printing a table that quietly compares two experiments.
export const SUITE_VERSION = 1;
export const SUITE = {
  prompt: "BP3",
  k: 10,
  seeds: [1, 2],
  icebreakerVariant: "R3",
  icebreakerBucket: "reverse-dense",
  icebreakerLangs: ["sk", "en"],
  icebreakerReps: 6,
};

const args = process.argv.slice(2);
const MODEL = args.find((a) => !a.startsWith("--"));
if (!MODEL) {
  console.error("usage: node bakeoff.mjs <venice-model-id> [--reps N] [--langs sk,en] [--skip-icebreakers]");
  process.exit(1);
}
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const REPS = Number(flag("reps", SUITE.icebreakerReps));
const LANGS = String(flag("langs", SUITE.icebreakerLangs.join(","))).split(",").filter(Boolean);
const SKIP_IB = args.includes("--skip-icebreakers");

// A model Venice has never been asked about prices at exactly $0.0000, which on
// a card whose headline is cost reads as "free" rather than "unknown" — and the
// scenario where that bites is precisely the one this tool exists for: a model
// that dropped this morning. Refuse, and name the one-line fix.
if (!priceOf(MODEL) && !args.includes("--allow-unpriced")) {
  console.error(
    `\n✗ no price known for "${MODEL}".\n` +
    `  The pinned table in lib.mjs does not have it and it is not in venice-models.json.\n` +
    `  Fix:   node refresh-models.mjs ${MODEL.split("-")[0]}     # snapshot Venice's catalogue, and check the id\n` +
    `  Force: node bakeoff.mjs ${MODEL} --allow-unpriced   # every cost on the card will read $0.0000\n`,
  );
  process.exit(1);
}

// The whole suite sends strict `response_format: json_schema`. A model whose
// catalogue entry says it cannot take one answers every call with
// 400 "response_format is not supported by this model" — minimax-m3-preview
// does, and the catalogue says so honestly. Checking costs nothing and saves
// ~25 minutes of a run that was never going to produce a row.
//
// Note the asymmetry with the reasoning capability: the catalogue is RELIABLE
// about response schema and NOT reliable about reasoning effort (GLM 5.3 Flash
// advertises `"none"` and rejects it), which is why one is a pre-flight check
// and the other is detected on the model's own 400.
{
  const spec = snapshotSpec(MODEL);
  if (spec && spec.supportsResponseSchema === false && !args.includes("--allow-no-schema")) {
    console.error(
      `\n✗ ${MODEL} reports supportsResponseSchema: false.\n` +
      `  Every arm of this suite sends a strict json_schema; this model 400s on all of them.\n` +
      `  Override with --allow-no-schema only if you have changed the harness to send\n` +
      `  prompt-instructed JSON instead (run.mjs has a NO_SCHEMA hook for exactly that).\n`,
    );
    process.exit(1);
  }
  if (!spec) {
    console.error(`  ⚠ ${MODEL} is not in venice-models.json — capabilities unknown. ` +
      `Run \`node refresh-models.mjs\` if it shipped recently.`);
  }
}

function sh(cmd, argv, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { cwd: here, stdio: "inherit", env: { ...process.env, ...env } });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${argv.join(" ")} exited ${code}`))));
  });
}

const safe = (s) => s.replace(/[^a-zA-Z0-9._-]/g, "");
const scoringFile = (seed, subset) =>
  join(here, "results", `${SUITE.prompt}_K${SUITE.k}_${safe(MODEL)}_seed${seed}_${subset ? "subset" : "full"}.json`);
const icebreakerFile = () =>
  join(here, "results",
    `ICEBREAKER_${safe(MODEL)}_K${SUITE.k}_${LANGS.join("-")}_${SUITE.icebreakerVariant}` +
    `_${SUITE.icebreakerBucket}${REPS > 1 ? `_x${REPS}` : ""}.json`);

// ── arms ─────────────────────────────────────────────────────────────────────
async function scoringArm(seed, subset) {
  const out = scoringFile(seed, subset);
  const argv = ["run.mjs", "--model", MODEL, "--prompt", SUITE.prompt, "--k", String(SUITE.k), "--seed", String(seed)];
  if (subset) argv.push("--subset");
  console.log(`\n── scoring: ${SUITE.prompt} K=${SUITE.k} seed=${seed} ${subset ? "subset" : "full-190"} ──`);
  await sh(process.execPath, argv);
  if (!existsSync(out)) throw new Error(`expected ${out}`);
  return JSON.parse(readFileSync(out, "utf8"));
}

async function icebreakerArm() {
  const out = icebreakerFile();
  console.log(`\n── icebreakers: ${SUITE.icebreakerVariant} K=${SUITE.k} ${LANGS.join(",")} ${SUITE.icebreakerBucket} ×${REPS} ──`);
  await sh(
    process.execPath,
    ["icebreaker-run.mjs", MODEL, String(SUITE.k), LANGS.join(","), SUITE.icebreakerVariant, SUITE.icebreakerBucket],
    // CONC=8, not the script's 16: Venice refuses concurrency past a model's
    // allowance with an immediate 429 rather than queueing it, and a bake-off
    // that spends its wall-clock in backoff reports latency for a queue, not a
    // model. See the README's "Venice refuses concurrency" note.
    { REPEATS: String(REPS), CONC: process.env.CONC ?? "8" },
  );
  if (!existsSync(out)) throw new Error(`expected ${out}`);
  return JSON.parse(readFileSync(out, "utf8"));
}

// ── projections ──────────────────────────────────────────────────────────────
/**
 * Cost to score 100 attendees, on the same basis as MATCHING-BENCHMARK.md:
 * prefiltering leaves ~2k pairs per 100 attendees = 4k DIRECTIONAL scorings.
 * Derived from the full-190 run rather than the subset, because that run's
 * batches are the production batch size (10) and the subset's are not.
 */
function costPer100(full) {
  if (!full?.edges?.length || !priceOf(MODEL)) return null;
  return (full.stats.costUsd / full.edges.length) * 4000;
}

/**
 * Wall-clock to score 100 attendees at 8-way concurrency, from the SERIAL p50.
 * A projection, not a measurement — labelled as such wherever it is printed, and
 * optimistic by exactly as much as Venice's concurrency cap bites.
 */
function minutesPer100(serialP50, conc = 8) {
  if (!serialP50) return null;
  const callsPer100 = 4000 / SUITE.k;
  return (callsPer100 * serialP50) / conc / 60000;
}

function pooledScoring(runs) {
  // Pool the two subset seeds by AVERAGING each (target, candidate) edge, not by
  // concatenating them. Concatenation looked equivalent and is not: recall@3 is
  // computed over a per-target ranked list, and a list holding every candidate
  // twice pushes a genuine rank-2 partner to rank 4-5. The pooled rate would
  // then read as a regression that only exists in the pooling.
  //
  // slotIndex is kept from the first seed purely so position bias remains
  // computable; posBias is reported per-seed anyway, where it is honest.
  const byEdge = new Map();
  for (const r of runs) {
    for (const e of r.edges) {
      const k = `${e.target}|${e.candidate}`;
      if (!byEdge.has(k)) byEdge.set(k, { ...e, _n: 0, _sim: 0, _comp: 0, _score: 0 });
      const acc = byEdge.get(k);
      acc._n++;
      acc._sim += e.similarity;
      acc._comp += e.complementarity;
      acc._score += e.score;
    }
  }
  const pooledEdges = [...byEdge.values()].map((e) => ({
    target: e.target, candidate: e.candidate, slotIndex: e.slotIndex, batchSize: e.batchSize,
    similarity: e._sim / e._n, complementarity: e._comp / e._n, score: e._score / e._n,
    reasoning: e.reasoning,
  }));
  const merged = {
    label: `${SUITE.prompt}|K${SUITE.k}|${MODEL}|seeds${SUITE.seeds.join("+")}|subset`,
    model: MODEL, prompt: SUITE.prompt, k: SUITE.k, seed: "pooled", subset: true,
    edges: pooledEdges,
    stats: runs.reduce(
      (a, r) => ({
        calls: a.calls + r.stats.calls,
        formatFails: a.formatFails + r.stats.formatFails,
        missingCandidates: a.missingCandidates + r.stats.missingCandidates,
        latencyP50: Math.round((a.latencyP50 + r.stats.latencyP50) / 2),
        latencyP95: Math.round((a.latencyP95 + r.stats.latencyP95) / 2),
        costUsd: a.costUsd + r.stats.costUsd,
        usage: {
          promptTokens: a.usage.promptTokens + r.stats.usage.promptTokens,
          completionTokens: a.usage.completionTokens + r.stats.usage.completionTokens,
          totalTokens: a.usage.totalTokens + r.stats.usage.totalTokens,
          reasoningTokens: a.usage.reasoningTokens + (r.stats.usage.reasoningTokens ?? 0),
        },
      }),
      { calls: 0, formatFails: 0, missingCandidates: 0, latencyP50: 0, latencyP95: 0, costUsd: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 } },
    ),
  };
  return evalRun(merged);
}

/**
 * Collapse graded openers into one {err, n} per LLM call.
 *
 * `callId` is stamped by icebreaker-run.mjs. Rows recorded before 2026-08-26
 * have none; those fall back to the old (bucket, target, candidate, rep) key,
 * which over-splits reverse-shape calls — so a card built from such a run says
 * so rather than quietly reporting an over-confident p-value.
 */
function clustersOf(rows) {
  const byCall = new Map();
  let missing = 0;
  for (const row of rows) {
    if (!row.callId) missing++;
    const k = row.callId ?? `legacy|${row.bucket}|${row.target}|${row.candidate}|${row.rep}`;
    if (!byCall.has(k)) byCall.set(k, { err: 0, n: 0 });
    const c = byCall.get(k);
    c.n++;
    if (row.violations.some((v) => v === "THEFT" || v === "FALSE_CLAIM")) c.err++;
  }
  if (missing) {
    console.error(`  ⚠ ${missing} graded openers have no callId — re-run the icebreaker arm ` +
      `(it is cached) so the permutation test clusters by call rather than by pair`);
  }
  return [...byCall.values()];
}

function strictJsonOf(runs) {
  const ok = runs.reduce((a, r) => a + (r.stats.strictOkCalls ?? 0), 0);
  const known = runs.reduce((a, r) => a + (r.stats.strictKnownCalls ?? 0), 0);
  return { ok, known, pct: known ? Math.round((ok / known) * 1000) / 10 : null };
}

// ── main ─────────────────────────────────────────────────────────────────────
const subsetRuns = [];
for (const seed of SUITE.seeds) subsetRuns.push(await scoringArm(seed, true));
const fullRun = await scoringArm(SUITE.seeds[0], false);
const ice = SKIP_IB ? null : await icebreakerArm();
// Speed gets its own serial arm — see latency-probe.mjs for why the scoring
// arms' latency is the retry schedule rather than the model.
console.log(`\n── latency: 6 serial K=10 calls ──`);
const lat = await latencyProbe(MODEL, 6);

const scoringRuns = [...subsetRuns, fullRun];
const totalScoringCost = scoringRuns.reduce((a, r) => a + r.stats.costUsd, 0);
const iceCost = (ice?.runs ?? []).reduce((a, r) => a + (r.telemetry?.costUsd ?? 0), 0);

const card = {
  suiteVersion: SUITE_VERSION,
  model: MODEL,
  ranAt: new Date().toISOString(),
  spec: snapshotSpec(MODEL),
  price: priceOf(MODEL),
  priceSource: priceOf(MODEL) ? "pinned-or-snapshot" : "unknown",
  // The request shape this model actually accepts. `disableThinking: false`
  // means providers/venice.ts, which sends it unconditionally, 400s on every
  // call — a deployment blocker that no quality metric can see.
  requestProfile: modelProfile(MODEL),
  suite: { ...SUITE, icebreakerLangs: LANGS, icebreakerReps: REPS },
  // Hashes of the exact bytes sent. Two cards with different fingerprints were
  // measured under different prompts — most often a stale coordinator dist, which
  // silently benchmarks the previous release. Full text: record-prompts.mjs.
  promptFingerprint: await promptFingerprint(LANGS),

  scoring: {
    perSeedSubset: subsetRuns.map((r) => evalRun(r)),
    pooledSubset: pooledScoring(subsetRuns),
    full190: evalRun(fullRun),
    strictJson: strictJsonOf(scoringRuns),
    reasoningTokens: scoringRuns.reduce((a, r) => a + (r.stats.usage.reasoningTokens ?? 0), 0),
  },

  icebreakers: ice
    ? {
        variant: SUITE.icebreakerVariant,
        bucket: SUITE.icebreakerBucket,
        // Responses that contradicted the strict schema's top-level shape, and
        // calls whose body held no parseable JSON at all. Both are production
        // failures (`validateProviderValue` / `JSON.parse`), not benchmark noise.
        shapeDeviations: ice.runs.reduce((a, r) => a + (r.shapeDeviations ?? 0), 0),
        shapeKinds: ice.runs.reduce((a, r) => {
          for (const [k, n] of Object.entries(r.shapeKinds ?? {})) a[k] = (a[k] ?? 0) + n;
          return a;
        }, {}),
        failedCalls: ice.runs.reduce((a, r) => a + (r.failed ?? 0), 0),
        perLang: ice.runs.map((r) => ({
          lang: r.lang, label: r.label, failedCalls: r.failed,
          shapeDeviations: r.shapeDeviations ?? 0,
          ...r.summary,
          telemetry: r.telemetry ?? null,
        })),
        // Pooled over languages: the denominator is openers, and both languages
        // are production reality for this project.
        pooled: (() => {
          const rows = ice.runs.flatMap((r) => r.rows);
          const c = (code) => rows.filter((r) => r.violations.includes(code)).length;
          const pct = (n) => (rows.length ? Math.round((n / rows.length) * 1000) / 10 : 0);
          const theft = c("THEFT"), falseClaim = c("FALSE_CLAIM"), briefing = c("BRIEFING");
          return {
            total: rows.length,
            grounded: rows.filter((r) => r.mentionsTarget || r.mentionsCandidate).length,
            attributionErrors: theft + falseClaim, attributionErrorPct: pct(theft + falseClaim),
            theft, falseClaim, briefing, briefingPct: pct(briefing),
            clean: rows.filter((r) => r.violations.length === 0).length,
            cleanPct: pct(rows.filter((r) => r.violations.length === 0).length),
          };
        })(),
        // Did it write in the event's language at all? Added 2026-08-26 after
        // blind judging turned up Slovak-event openers written in English and in
        // CZECH. Nothing else in this suite looks at output language, which is
        // how the DEPLOYED model shipped a regression from 0/3372 to 90/1391
        // English openers unnoticed. String-match decidable, like attribution.
        language: Object.fromEntries(
          ice.runs.map((r) => {
            const c = { target: 0, english: 0, czech: 0, slovak: 0, undecided: 0 };
            for (const row of r.rows) c[detectLanguage(row.text, r.lang)]++;
            const n = r.rows.length;
            const wrong = r.lang === "sk" ? c.english + c.czech : c.czech + c.slovak;
            return [r.lang, { n, ...c, wrong, inLanguagePct: n ? Math.round(((n - wrong - c.undecided) / n) * 1000) / 10 : 0 }];
          }),
        ),
        // Per CALL, not per opener — the unit the permutation test shuffles.
        // Keyed on the `callId` the run stamps on every row: deriving it from
        // (target, candidate, rep) is wrong for the reverse shape, where one
        // call carries ten different targets. See icebreaker-run.mjs.
        clusters: ice.runs.flatMap((r) => clustersOf(r.rows)),
        clustersByLang: Object.fromEntries(
          ice.runs.map((r) => [r.lang, clustersOf(r.rows)]),
        ),
      }
    : null,

  cost: {
    benchmarkUsd: Math.round((totalScoringCost + iceCost + lat.costUsd) * 10000) / 10000,
    scoringUsd: Math.round(totalScoringCost * 10000) / 10000,
    icebreakerUsd: Math.round(iceCost * 10000) / 10000,
    per100AttendeesUsd: costPer100(fullRun),
  },
  speed: {
    // The comparable numbers: one call at a time, K=10, production's prompt.
    serialLatencyP50Ms: lat.latencyP50,
    serialLatencyP95Ms: lat.latencyP95,
    serialCalls: lat.calls,
    outputTokensPerSec: lat.outputTokensPerSec,
    meanCompletionTokens: lat.meanCompletionTokens,
    meanReasoningTokens: lat.meanReasoningTokens,
    // Kept for continuity with the 2026-07 tables, but these were recorded with
    // 16 calls in flight and are contaminated by Venice's 429-and-back-off
    // behaviour. Do not compare them across models.
    underConcurrency16: { p50Ms: fullRun.stats.latencyP50, p95Ms: fullRun.stats.latencyP95 },
    icebreakerLatencyP50Ms: ice?.runs?.[0]?.telemetry?.latencyP50 ?? null,
    projectedMinutesPer100AtConc8: minutesPer100(lat.latencyP50),
  },

  // Everything a later blind re-grade needs, without re-billing: the exact text
  // this model produced, keyed the way judge-pack.mjs keys it.
  artifacts: {
    scoringResults: scoringRuns.map((r) => r.label),
    icebreakerResult: ice ? icebreakerFile().replace(here + "/", "") : null,
  },
};

mkdirSync(join(here, "results", "bakeoff"), { recursive: true });
const out = join(here, "results", "bakeoff", `${safe(MODEL)}.json`);
writeFileSync(out, JSON.stringify(card, null, 2) + "\n");

const s = card.scoring.pooledSubset;
const f = card.scoring.full190;
console.log(`\n${"=".repeat(72)}\n${MODEL} — suite v${SUITE_VERSION}\n${"=".repeat(72)}`);
console.log(`request profile   disable_thinking=${card.requestProfile.disableThinking}` +
  (card.requestProfile.reason ? `  (${card.requestProfile.reason})` : ""));
console.log(`strict JSON       ${card.scoring.strictJson.ok}/${card.scoring.strictJson.known} calls` +
  ` (${card.scoring.strictJson.pct}%) parse with JSON.parse — production's parser`);
console.log(`scoring subset    r@1 ${s.recall1.toFixed(2)}  r@3 ${s.recall3.toFixed(2)}  sep ${s.sepStrongWeak.toFixed(2)}  posBias ${s.posBias.toFixed(2)}  fails ${s.formatFails}`);
console.log(`scoring full-190  r@1 ${f.recall1.toFixed(2)}  r@3 ${f.recall3.toFixed(2)}  sep ${f.sepStrongWeak.toFixed(2)}  posBias ${f.posBias.toFixed(2)}  fails ${f.formatFails}  miss ${f.missingCandidates}`);
if (card.icebreakers) {
  const p = card.icebreakers.pooled;
  console.log(`icebreakers       n=${p.total}  attribution-errors ${p.attributionErrors} (${p.attributionErrorPct}%)  briefing ${p.briefingPct}%  clean ${p.cleanPct}%`);
  for (const [lang, l] of Object.entries(card.icebreakers.language ?? {})) {
    const bad = l.inLanguagePct < 98 ? "  ⚠ WROTE THE WRONG LANGUAGE" : "";
    console.log(`  lang ${lang}          ${l.inLanguagePct}% in-language (n=${l.n})` +
      (lang === "sk" ? `  english ${l.english}  czech ${l.czech}` : "") + bad);
  }
}
console.log(`cost              $${card.cost.benchmarkUsd} this run  →  $${card.cost.per100AttendeesUsd?.toFixed(3)} per 100 attendees (projected)`);
console.log(`speed             p50 ${card.speed.serialLatencyP50Ms}ms / p95 ${card.speed.serialLatencyP95Ms}ms per K=10 call (serial), ` +
  `${card.speed.outputTokensPerSec} output tok/s` +
  (card.speed.meanReasoningTokens ? `, ${card.speed.meanReasoningTokens} reasoning tok/call` : ""));
console.log(`\nwrote ${out.replace(here + "/", "")}`);
