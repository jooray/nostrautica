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
import { languageFloorCheck } from "./language-adherence.mjs";

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
// Fingerprint KEYS have been renamed once already (`icebreaker.system.R3.sk` →
// `icebreaker.system.sk`, when the fingerprint started calling the coordinator's
// own builder instead of reconstructing the prompt). Comparing raw key names put
// the old and new hashes in different buckets, so the two never met and the
// check passed silently on cards that genuinely differed — the drift detector
// blind to the drift it exists for, a second time. Normalise the name, and say
// so loudly when two cards do not even describe the same prompts.
const canonicalFpName = (n) => n.replace(/\.(R\d+|IB\d+|L\d+|BP\d+|P\d+)(?=\.|$)/g, "");
if (fps.length > 1) {
  const names = [...new Set(fps.flatMap((c) => Object.keys(c.promptFingerprint).map(canonicalFpName)))];
  for (const n of names) {
    const seen = new Map();
    for (const c of fps) {
      for (const [k, v] of Object.entries(c.promptFingerprint)) {
        if (canonicalFpName(k) !== n) continue;
        if (!seen.has(v)) seen.set(v, []);
        seen.get(v).push(c.model);
      }
    }
    if (seen.size > 1) {
      console.log(`⚠ prompt \`${n}\` differs between cards — this table's rows were NOT ` +
        `measured under the same prompt:`);
      for (const [hash, models] of seen) console.log(`    ${hash}  ${models.join(", ")}`);
      console.log(`  Re-run the older models' affected arm against the current prompt ` +
        `before comparing those columns.\n`);
    }
  }
}
const noFp = cards.filter((c) => !c.promptFingerprint).map((c) => c.model);
if (noFp.length) console.log(`⚠ no prompt fingerprint recorded for: ${noFp.join(", ")} (re-run bakeoff.mjs — it is cached and free)\n`);

// Deployability measured against production's OWN provider (provider-probe.mjs),
// if it has been run. This outranks every inference drawn from harness telemetry:
// the harness is a reimplementation of providers/venice.ts, and both times this
// report has been wrong about adoption, it was wrong because the two drifted.
const probes = {};
for (const f of readdirSync(join(here, "results"))) {
  if (!f.startsWith("PROBE_") || !f.endsWith(".json")) continue;
  const p = JSON.parse(readFileSync(join(here, "results", f), "utf8"));
  if (p.model) probes[p.model] = p;
}

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
  const notes = [];
  // Both of the entries that used to live here described providers/venice.ts as
  // it was in August, and BOTH stopped being true while this function went on
  // printing them — blocking the suite's quality-and-cost winner on defects the
  // coordinator had already fixed:
  //
  //   • `disable_thinking` became per-model on 2026-08-26 (cbc564d): venice.ts
  //     probes once, remembers the refusal for the process, and honours
  //     `models.<role>.disable_thinking`. A model that rejects it is handled.
  //   • the bare `JSON.parse` became `parseModelJson` on 2026-09-04 (5f5468c),
  //     which strips a whole-output fence and falls back to the outermost JSON
  //     span. A fenced responder is no longer a total outage.
  //
  // So neither is a blocker now. `disableThinking:false` is a cost note (reasoning
  // tokens are billed even when hidden), and the parse gate asks the question
  // production actually asks — measured with production's own parser, imported
  // from dist by lib.mjs rather than reimplemented here.
  if (c.requestProfile?.disableThinking === false) {
    notes.push("reasons unconditionally — venice.ts handles this per-model, but reasoning tokens are billed");
  }
  const vj = c.scoring?.veniceJson;
  const sj = c.scoring?.strictJson;
  if (vj && vj.known > 0 && vj.pct !== null && vj.pct < 100) {
    out.push(`only ${vj.pct}% of responses survive \`parseModelJson\` — venice.ts rejects the rest`);
  } else if (!vj?.known && sj && sj.known > 0 && sj.pct !== null && sj.pct < 100) {
    // An older card whose calls were cached before raw bodies were kept, and
    // whose model did NOT parse strictly — so nothing can be derived and the
    // real number is genuinely unknown. Say that, rather than blocking on the
    // obsolete metric or quietly reporting a clean sheet. A cached run cannot
    // answer this: the cache held only the parsed entries, so grading it needs
    // fresh calls (`--refresh`, or a cache wipe for that model).
    notes.push(
      `${sj.pct}% bare-JSON.parse rate, and parseModelJson was never measured on this card — ` +
        `re-run with --refresh to find out whether venice.ts would accept it`,
    );
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
  // is a wrong answer that every attendee sees. The floor and its calibration
  // live in language-adherence.mjs, so this gate and the run summary cannot
  // drift apart the way they had.
  for (const [lang, l] of Object.entries(c.icebreakers?.language ?? {})) {
    const v = languageFloorCheck(lang, l);
    if (!v.ok) out.push(v.detail);
  }
  // The empirical verdict, last so it reads as the summary it is. A model that
  // cannot complete a production call is not deployable whatever the rest of
  // the table says — and this is the only check that runs the real code path.
  const probe = probes[c.model];
  if (probe && probe.failed > 0) {
    const kinds = Object.entries(probe.kinds ?? {}).map(([k, n]) => `${k}×${n}`).join(", ");
    out.push(
      `provider probe: only ${probe.ok}/${probe.calls} production calls succeeded through ` +
        `providers/venice.ts (${kinds})`,
    );
  } else if (!probe) {
    notes.push("not probed against providers/venice.ts — run `node provider-probe.mjs <model>`");
  } else if (probe.entryYield !== null && probe.entryYield < 99) {
    // Succeeding while dropping targets is a partial outage: a missing entry is
    // a pair that never gets scored.
    out.push(`provider probe: only ${probe.entryYield}% of requested entries came back scored`);
  }
  return { blocking: out, notes };
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
  "strictJSON", "sk-in-lang", "attr-err", "reason-inv", "brief", "judge R", "judge IB", "p50 s", "tok/s", "$/100"];
const cells = rows.map((r) => [
  r.model,
  r.price,
  fmt(r.sub.recall1), fmt(r.sub.recall3),
  fmt(r.full.recall1), fmt(r.full.recall3),
  fmt(r.full.sepStrongWeak), fmt(r.full.orderSW), fmt(r.full.posBias),
  r.strict.known ? `${r.strict.pct}%` : "–",
  r.ice?.language?.sk ? `${r.ice.language.sk.inLanguagePct}%` : "–",
  r.ice ? `${r.ice.pooled.attributionErrorPct}% (${r.ice.pooled.attributionErrors}/${r.ice.pooled.total})` : "–",
  // reasoning_for_target inversions. "–" means the card predates the arm, which
  // is not the same as zero — see bakeoff.mjs.
  r.ice?.reasoning
    ? `${r.ice.reasoning.pooled.invertedPct}% (${r.ice.reasoning.pooled.inverted}/${r.ice.reasoning.pooled.total})`
    : "–",
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
  if (r.blockers.blocking.length) {
    console.log(`✗ ${r.model} — NOT deployable as coded today:`);
    for (const b of r.blockers.blocking) console.log(`    • ${b}`);
  }
  // Worth knowing, not disqualifying — kept visually distinct from a blocker so
  // the two can never be read as the same verdict again.
  for (const n of r.blockers.notes) console.log(`· ${r.model} — ${n}`);
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
