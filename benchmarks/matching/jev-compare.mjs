/**
 * Reproducibility of the TOP of each target's list between two runs of the same
 * configuration (different seeds), the metric docs/MATCHING-BENCHMARK.md
 * (2026-09-13) found the deployed scorer weakest on: Kendall tau over each
 * target's top-N, and how often the #1 survives. Also tie structure: distinct
 * score values overall and inside a top five, targets with a tied #1.
 *
 *   node jev-compare.mjs results/A.json results/B.json [--top 5]
 */
import { readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const ti = argv.indexOf("--top");
const topN = ti >= 0 ? Number(argv[ti + 1]) : 5;
const files = argv.filter((a, i) => !a.startsWith("--") && i !== ti + 1);
const [A, B] = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
const byTarget = (run) => {
  const m = new Map();
  for (const e of run.edges) { if (!m.has(e.target)) m.set(e.target, []); m.get(e.target).push(e); }
  for (const l of m.values()) l.sort((x, y) => y.score - x.score || x.candidate.localeCompare(y.candidate));
  return m;
};
function kendall(order, scoresOther) {
  // tau-b over the items of `order`, comparing rank in A (given order) vs score in B
  let c = 0, d = 0, tb = 0;
  for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) {
    const sb = scoresOther.get(order[i]) - scoresOther.get(order[j]);
    if (sb > 0) c++; else if (sb < 0) d++; else tb++;
  }
  const n0 = c + d + tb;
  return n0 ? (c - d) / Math.sqrt(n0 * (n0 - tb)) : 0;
}
const ta = byTarget(A), tb = byTarget(B);
let taus = [], same1 = 0, n = 0, tied1 = 0, distinctTop = [];
for (const [t, la] of ta) {
  const lb = tb.get(t); if (!lb) continue;
  const top = la.slice(0, topN).map((e) => e.candidate);
  const sb = new Map(lb.map((e) => [e.candidate, e.score]));
  if (top.every((c) => sb.has(c))) taus.push(kendall(top, sb));
  n++;
  if (la[0].candidate === lb[0].candidate) same1++;
  if (la.length > 1 && la[0].score === la[1].score) tied1++;
  distinctTop.push(new Set(la.slice(0, 5).map((e) => e.score.toFixed(3))).size);
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const allA = A.edges.map((e) => +e.score.toFixed(3));
console.log(JSON.stringify({
  a: A.label, b: B.label, top: topN, targets: n,
  meanTauTop: +mean(taus).toFixed(3), sameNo1: `${same1}/${n}`,
  tiedNo1_inA: tied1, distinctValues_inA: new Set(allA).size, meanDistinctInTop5_A: +mean(distinctTop).toFixed(2),
  edgesA: A.edges.length, edgesB: B.edges.length,
}, null, 1));
