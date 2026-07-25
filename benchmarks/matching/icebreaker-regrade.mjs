/**
 * Re-grade a saved run in place. The runner stores every icebreaker verbatim, so
 * a grader fix is re-scored offline for free — no API spend to correct a metric.
 *   node icebreaker-regrade.mjs results/ICEBREAKER_<model>_K<k>.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PERSONA_BY_ID } from "./icebreaker-fixture.mjs";
import { gradeIcebreaker, mentionsEntity, summarize } from "./icebreaker-grade.mjs";

const path = process.argv[2];
const data = JSON.parse(readFileSync(path, "utf8"));

// Runs from 2026-07-24 stored { before, after }; per-language runs store a `runs`
// array. Both shapes are re-gradable — the point of this script is that a grader
// fix costs no API spend, including on results saved before the grader changed.
const runs = Array.isArray(data.runs) ? data.runs : [data.before, data.after].filter(Boolean);

for (const r of runs) {
  for (const row of r.rows) {
    const target = PERSONA_BY_ID.get(row.target);
    const cand = PERSONA_BY_ID.get(row.candidate);
    if (!target || !cand) throw new Error(`unknown persona in row: ${row.target} / ${row.candidate}`);
    row.mentionsTarget = mentionsEntity(row.text, target.signature.entity);
    row.mentionsCandidate = mentionsEntity(row.text, cand.signature.entity);
    row.violations = gradeIcebreaker(row.text, target, cand);
  }
  const show = (s, tag) =>
    console.log(
      `${(r.label + (r.lang ? "/" + r.lang : "")).padEnd(18)} ${tag.padEnd(7)} n=${String(s.total).padStart(3)}  ` +
        `attribution ${String(s.attributionErrors).padStart(2)} (${s.attributionErrorPct}%)  ` +
        `[theft ${s.theft} / false-claim ${s.falseClaim}]  ` +
        `briefing ${s.briefing} (${s.briefingPct}%)  clean ${s.cleanPct}%  ` +
        `names-an-artifact ${s.grounded} (${s.groundedPct}%)`,
    );
  r.summary = summarize(r.rows);
  show(r.summary, "all");
  if (r.rows.some((x) => x.bucket)) {
    r.baseSummary = summarize(r.rows.filter((x) => x.bucket === "base"));
    r.sharerSummary = summarize(r.rows.filter((x) => x.sharer));
    show(r.baseSummary, "base");
    show(r.sharerSummary, "shared");
  }
}
writeFileSync(path, JSON.stringify(data, null, 2));
for (const r of runs) {
  const bad = r.rows.filter((x) => x.violations.length);
  const label = r.label + (r.lang ? "/" + r.lang : "");
  if (!bad.length) { console.log(`\n${label}: nothing flagged`); continue; }
  console.log(`\n--- ${label}: ${bad.length} flagged ---`);
  for (const b of bad.slice(0, 8)) {
    console.log(`  [${b.violations.join(",")}${b.sharer ? ",SHARER" : ""}] ${b.text.slice(0, 170)}`);
  }
}
