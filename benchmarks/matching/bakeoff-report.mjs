/**
 * The cross-model table. Reads every card in results/bakeoff/ and prints the
 * comparison, with exact statistics where the counts are small.
 *
 *   node bakeoff-report.mjs             # table
 *   node bakeoff-report.mjs --md        # markdown, for pasting into the doc
 *   node bakeoff-report.mjs --baseline deepseek-v4-flash-0731
 *
 * Two habits from the earlier rounds are enforced here rather than left to the
 * reader:
 *
 * 1. **Deployability before quality.** A model that cannot be driven the way
 *    `providers/venice.ts` drives it, or whose output `JSON.parse` rejects, is
 *    reported as BLOCKED at the top of its row no matter how good its recall is.
 *    The 2026-07 round nearly adopted a model on a quality number before anyone
 *    checked its format-failure rate; here the check is a column.
 *
 * 2. **Read the tables with a test, not with your eyes.** Attribution errors run
 *    at a fraction of a percent, and eyeballing "2 vs 5" across arms is how you
 *    talk yourself into a regression that is noise. Every icebreaker comparison
 *    against the baseline gets a Clopper-Pearson interval and a permutation test
 *    over CALLS (openers inside one call are correlated — see stats.mjs).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ciExact, permutationTestRate } from "./stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CARDS = join(here, "results", "bakeoff");
const argv = process.argv.slice(2);
const MD = argv.includes("--md");
const BASELINE = argv[argv.indexOf("--baseline") + 1] ?? "deepseek-v4-flash-0731";

const cards = readdirSync(CARDS).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(CARDS, f), "utf8")));
if (!cards.length) throw new Error("no cards — run bakeoff.mjs <model> first");

const versions = [...new Set(cards.map((c) => c.suiteVersion))];
if (versions.length > 1) {
  throw new Error(`cards span suite versions ${versions.join(", ")} — re-run the older ones; ` +
    `a table that mixes suites compares two experiments, not two models`);
}

// Prompt drift. Cards measured under different prompt bytes are not rows of one
// table; the usual cause is a coordinator rebuild between two models' runs.
const fps = cards.filter((c) => c.promptFingerprint);
if (fps.length > 1) {
  const names = [...new Set(fps.flatMap((c) => Object.keys(c.promptFingerprint)))];
  for (const n of names) {
    const seen = [...new Set(fps.map((c) => c.promptFingerprint[n]).filter(Boolean))];
    if (seen.length > 1) {
      console.log(`⚠ prompt \`${n}\` differs between cards (${seen.join(" vs ")}) — ` +
        `re-run the older model against the current prompt before trusting this table.\n`);
    }
  }
}
const noFp = cards.filter((c) => !c.promptFingerprint).map((c) => c.model);
if (noFp.length) console.log(`⚠ no prompt fingerprint recorded for: ${noFp.join(", ")} (re-run bakeoff.mjs — it is cached and free)\n`);

// Subjective grades, if any have been recorded.
const J = join(here, "judging");
let judge = {};
if (existsSync(join(J, "key.json")) && existsSync(join(J, "grades.json"))) {
  const key = JSON.parse(readFileSync(join(J, "key.json"), "utf8"));
  const grades = JSON.parse(readFileSync(join(J, "grades.json"), "utf8"));
  for (const [id, meta] of Object.entries(key.items)) {
    const g = grades[id];
    if (!g) continue;
    for (const m of meta.models) {
      judge[m] ??= { reasoning: [], icebreaker: [] };
      judge[m][meta.kind]?.push(g.score);
    }
  }
}
const mean = (xs) => (xs?.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (n, d = 2) => (typeof n === "number" && isFinite(n) ? n.toFixed(d) : "–");

/** Anything that makes the model unusable in production as it is coded today. */
function blockers(c) {
  const out = [];
  if (c.requestProfile?.disableThinking === false) {
    out.push("rejects `disable_thinking` (venice.ts sends it unconditionally → HTTP 400)");
  }
  const sj = c.scoring?.strictJson;
  if (sj && sj.known > 0 && sj.pct !== null && sj.pct < 100) {
    out.push(`only ${sj.pct}% of responses survive \`JSON.parse\` (venice.ts does not parse leniently)`);
  }
  if ((c.scoring?.full190?.formatFails ?? 0) > 0) out.push(`${c.scoring.full190.formatFails} format failures`);
  if ((c.icebreakers?.shapeDeviations ?? 0) > 0) {
    const kinds = Object.entries(c.icebreakers.shapeKinds ?? {}).map(([k, n]) => `${k}×${n}`).join(", ");
    out.push(`${c.icebreakers.shapeDeviations} response(s) ignored the strict schema's top-level shape` +
      `${kinds ? ` (${kinds})` : ""} — \`validateProviderValue\` rejects these outright`);
  }
  if ((c.icebreakers?.failedCalls ?? 0) > 0) {
    out.push(`${c.icebreakers.failedCalls} icebreaker call(s) returned no parseable JSON at all`);
  }
  // A model that answers a Slovak event in Czech is not a quality gradation, it
  // is a wrong answer that every attendee sees. 5% is the threshold at which the
  // deployed model's own regression would have been caught.
  for (const [lang, l] of Object.entries(c.icebreakers?.language ?? {})) {
    if (l.inLanguagePct < 95) {
      out.push(`only ${l.inLanguagePct}% of ${lang} openers were actually in ${lang} ` +
        `(${l.english} English, ${l.czech} Czech, n=${l.n})`);
    }
  }
  return out;
}

const rows = cards.map((c) => ({
  model: c.model,
  price: c.price ? `$${c.price.in}/$${c.price.out}` : "?",
  sub: c.scoring.pooledSubset,
  full: c.scoring.full190,
  ice: c.icebreakers,
  cost100: c.cost.per100AttendeesUsd,
  p50: c.speed.serialLatencyP50Ms ?? c.speed.scoringLatencyP50Ms,
  tps: c.speed.outputTokensPerSec ?? null,
  reasoningPerCall: c.speed.meanReasoningTokens ?? 0,
  reasoningTokens: c.scoring.reasoningTokens,
  strict: c.scoring.strictJson,
  blockers: blockers(c),
  judge: judge[c.model],
})).sort((a, b) => (b.full.recall3 - a.full.recall3) || (b.full.sepStrongWeak - a.full.sepStrongWeak));

const H = ["model", "$/Mtok", "r@1 sub", "r@3 sub", "r@1 190", "r@3 190", "sep", "ord>W", "posB",
  "strictJSON", "sk-in-lang", "attr-err", "brief", "judge R", "judge IB", "p50 s", "tok/s", "$/100"];
const cells = rows.map((r) => [
  r.model,
  r.price,
  fmt(r.sub.recall1), fmt(r.sub.recall3),
  fmt(r.full.recall1), fmt(r.full.recall3),
  fmt(r.full.sepStrongWeak), fmt(r.full.orderSW), fmt(r.full.posBias),
  r.strict.known ? `${r.strict.pct}%` : "–",
  r.ice?.language?.sk ? `${r.ice.language.sk.inLanguagePct}%` : "–",
  r.ice ? `${r.ice.pooled.attributionErrorPct}% (${r.ice.pooled.attributionErrors}/${r.ice.pooled.total})` : "–",
  r.ice ? `${r.ice.pooled.briefingPct}%` : "–",
  fmt(mean(r.judge?.reasoning), 2), fmt(mean(r.judge?.icebreaker), 2),
  (r.p50 / 1000).toFixed(1),
  r.tps != null ? String(r.tps) : "–",
  r.cost100 != null ? `$${r.cost100.toFixed(3)}` : "–",
]);

if (MD) {
  console.log(`| ${H.join(" | ")} |`);
  console.log(`|${H.map(() => "---").join("|")}|`);
  for (const c of cells) console.log(`| ${c.join(" | ")} |`);
} else {
  const w = H.map((h, i) => Math.max(h.length, ...cells.map((c) => String(c[i]).length)));
  console.log(H.map((h, i) => h.padEnd(w[i])).join("  "));
  console.log(w.map((n) => "─".repeat(n)).join("  "));
  for (const c of cells) console.log(c.map((x, i) => String(x).padEnd(w[i])).join("  "));
}

console.log("");
for (const r of rows) {
  if (r.blockers.length) {
    console.log(`✗ ${r.model} — NOT deployable as coded today:`);
    for (const b of r.blockers) console.log(`    • ${b}`);
  }
}

// ── exact statistics on the attribution counts ───────────────────────────────
const base = rows.find((r) => r.model === BASELINE);
if (base?.ice) {
  console.log(`\nattribution errors vs baseline ${BASELINE} (95% Clopper-Pearson; permutation test over calls):`);
  for (const r of rows) {
    if (!r.ice) continue;
    const p = r.ice.pooled;
    const [lo, hi] = ciExact(p.attributionErrors, p.total);
    let line = `  ${r.model.padEnd(24)} ${p.attributionErrors}/${p.total} = ${(p.attributionErrorPct).toFixed(2)}%  ` +
      `CI [${(lo * 100).toFixed(2)}%, ${(hi * 100).toFixed(2)}%]`;
    if (r.model !== BASELINE) {
      const t = permutationTestRate(r.ice.clusters, base.ice.clusters);
      line += `   p=${t.p.toFixed(3)}${t.p < 0.05 ? " *" : ""}`;
    }
    console.log(line);
  }
  console.log("  (* = the difference survives a test; anything else is the sample size talking.)");

  // Per language, ALWAYS — not as an optional drill-down. Pooling hid the single
  // significant result in this benchmark's first run: GLM 5.3 Flash makes ~14x
  // fewer attribution errors than the baseline in Slovak (p=0.0008) and slightly
  // more in English, and the two cancelled to a pooled p=0.151. A model that is
  // better in one language and worse in another is the normal case for a project
  // that runs events in more than one, so the pooled row is the summary and these
  // are the finding.
  const langs = [...new Set(rows.flatMap((r) => (r.ice?.perLang ?? []).map((l) => l.lang)))].sort();
  for (const lang of langs) {
    const base_l = base.ice.perLang.find((l) => l.lang === lang);
    if (!base_l) continue;
    console.log(`\n  — ${lang} —`);
    for (const r of rows) {
      const l = r.ice?.perLang?.find((x) => x.lang === lang);
      if (!l) continue;
      const [lo, hi] = ciExact(l.attributionErrors, l.total);
      let line = `    ${r.model.padEnd(24)} ${l.attributionErrors}/${l.total} = ${l.attributionErrorPct.toFixed(2)}%  ` +
        `CI [${(lo * 100).toFixed(2)}%, ${(hi * 100).toFixed(2)}%]`;
      if (r.model !== BASELINE) {
        const t = permutationTestRate(r.ice.clustersByLang?.[lang] ?? [], base.ice.clustersByLang?.[lang] ?? []);
        line += `   p=${t.p.toFixed(4)}${t.p < 0.05 ? " *" : ""}`;
      }
      console.log(line);
    }
  }
}


const noJudge = rows.filter((r) => !r.judge);
if (noJudge.length) {
  console.log(`\nno subjective grades yet for: ${noJudge.map((r) => r.model).join(", ")}` +
    ` — node judge-pack.mjs, grade judging/pack.md into judging/grades.json, then re-run.`);
}
