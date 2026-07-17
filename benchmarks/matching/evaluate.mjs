/**
 * Evaluation. Reads results/*.json edge files and computes, per run:
 *  - gold recall@1 / recall@3 (per-target ranking of candidates by score)
 *  - rank separation: mean score of strong vs medium vs weak edges; AUC-style
 *    ordering (fraction of strong>weak and strong>medium comparisons correct)
 *  - score discrimination: stdev / spread of scores (compression check)
 *  - position bias: Pearson corr(slotIndex, score) within multi-candidate batches
 *  - operational: calls, formatFails, missingCandidates, latency p50/p95, cost
 *
 * Gold labels loaded from gold-pairs.json (kept out of the model's view).
 *
 *   node evaluate.mjs                # table over all runs in results/
 *   node evaluate.mjs --json         # machine-readable
 */
import { readFileSync, readdirSync } from "node:fs";
import { PERSONAS } from "./personas.mjs";

const gold = JSON.parse(readFileSync("./gold-pairs.json", "utf8"));
const IDS = PERSONAS.map((p) => p.id);
const key = (a, b) => [a, b].sort().join("|");
const strongSet = new Set(gold.strong.map((g) => key(g.a, g.b)));
const mediumSet = new Set(gold.medium.map((g) => key(g.a, g.b)));
function labelOf(a, b) {
  const k = key(a, b);
  if (strongSet.has(k)) return "strong";
  if (mediumSet.has(k)) return "medium";
  return "weak";
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}
function stdev(xs) {
  const n = xs.length;
  if (!n) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / n);
}

export function evalRun(run) {
  const edges = run.edges;
  // edges are directional (target->candidate). Build per-target ranked lists.
  const byTarget = new Map();
  for (const e of edges) {
    if (!byTarget.has(e.target)) byTarget.set(e.target, []);
    byTarget.get(e.target).push(e);
  }

  // ── gold recall: for each persona that is a target AND has a gold-strong pair,
  //    is that strong partner in the target's top-1 / top-3 by score?
  let hit1 = 0, hit3 = 0, denom = 0;
  const strongPairs = gold.strong;
  for (const g of strongPairs) {
    for (const [t, partner] of [[g.a, g.b], [g.b, g.a]]) {
      const list = byTarget.get(t);
      if (!list) continue;
      // only count if the partner was actually a candidate for this target
      if (!list.some((e) => e.candidate === partner)) continue;
      const ranked = [...list].sort((x, y) => y.score - x.score);
      const rank = ranked.findIndex((e) => e.candidate === partner);
      denom++;
      if (rank === 0) hit1++;
      if (rank >= 0 && rank < 3) hit3++;
    }
  }

  // ── rank separation across all scored edges (dedup to undirected pair, avg dir)
  const pairScore = new Map();
  for (const e of edges) {
    const k = key(e.target, e.candidate);
    if (!pairScore.has(k)) pairScore.set(k, []);
    pairScore.get(k).push(e.score);
  }
  const scored = [...pairScore.entries()].map(([k, ss]) => {
    const [a, b] = k.split("|");
    return { label: labelOf(a, b), score: ss.reduce((x, y) => x + y, 0) / ss.length };
  });
  const byLbl = { strong: [], medium: [], weak: [] };
  for (const s of scored) byLbl[s.label].push(s.score);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

  // pairwise-ordering accuracy strong>weak and strong>medium
  let sw = 0, swN = 0, sm = 0, smN = 0;
  for (const s of byLbl.strong) {
    for (const w of byLbl.weak) { swN++; if (s > w) sw++; else if (s === w) sw += 0.5; }
    for (const m of byLbl.medium) { smN++; if (s > m) sm++; else if (s === m) sm += 0.5; }
  }

  // ── position bias: within multi-candidate edges, corr(slotIndex, score)
  const multi = edges.filter((e) => e.batchSize > 1);
  const posBias = pearson(multi.map((e) => e.slotIndex), multi.map((e) => e.score));

  // ── discrimination: stdev of all edge scores + separation strong-weak
  const allScores = edges.map((e) => e.score);
  const disc = stdev(allScores);

  // ── reasoning length (proxy; real quality judged separately/blind)
  const reasonLens = edges.map((e) => e.reasoning.length);
  const emptyReason = edges.filter((e) => !e.reasoning || e.reasoning.length < 15).length;

  return {
    label: run.label, model: run.model, prompt: run.prompt, k: run.k, seed: run.seed, subset: run.subset,
    recall1: denom ? hit1 / denom : 0,
    recall3: denom ? hit3 / denom : 0,
    recallDenom: denom,
    meanStrong: mean(byLbl.strong), meanMedium: mean(byLbl.medium), meanWeak: mean(byLbl.weak),
    sepStrongWeak: mean(byLbl.strong) - mean(byLbl.weak),
    orderSW: swN ? sw / swN : 0,
    orderSM: smN ? sm / smN : 0,
    disc,
    posBias,
    formatFails: run.stats.formatFails,
    missingCandidates: run.stats.missingCandidates,
    calls: run.stats.calls,
    latencyP50: run.stats.latencyP50,
    latencyP95: run.stats.latencyP95,
    costUsd: run.stats.costUsd,
    edges: edges.length,
    avgReasonLen: reasonLens.length ? Math.round(reasonLens.reduce((a, b) => a + b, 0) / reasonLens.length) : 0,
    emptyReason,
  };
}

function loadRuns() {
  return readdirSync("./results")
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync("./results/" + f, "utf8")));
}

function fmt(n, d = 2) {
  return typeof n === "number" && isFinite(n) ? n.toFixed(d) : "-";
}

function main() {
  const runs = loadRuns().filter((r) => r.edges);
  const rows = runs.map(evalRun).sort((a, b) =>
    (b.recall3 - a.recall3) || (b.sepStrongWeak - a.sepStrongWeak));
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const H = ["model", "prompt", "K", "sub", "r@1", "r@3", "sS", "sM", "sW", "sep", "o>W", "o>M", "disc", "posB", "ff", "miss", "lat50", "$", "empty"];
  console.log(H.join("\t"));
  for (const r of rows) {
    console.log([
      r.model.slice(0, 22), r.prompt, r.k, r.subset ? "Y" : "N",
      fmt(r.recall1), fmt(r.recall3),
      fmt(r.meanStrong), fmt(r.meanMedium), fmt(r.meanWeak), fmt(r.sepStrongWeak),
      fmt(r.orderSW), fmt(r.orderSM), fmt(r.disc), fmt(r.posBias),
      r.formatFails, r.missingCandidates, r.latencyP50, fmt(r.costUsd, 4), r.emptyReason,
    ].join("\t"));
  }
}
main();
