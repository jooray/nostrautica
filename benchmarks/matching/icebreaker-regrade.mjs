/**
 * Re-grade a saved run in place. The runner stores every icebreaker verbatim, so
 * a grader fix is re-scored offline for free — no API spend to correct a metric.
 *   node icebreaker-regrade.mjs results/ICEBREAKER_<model>_K<k>.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { SIGNED_PERSONAS } from "./icebreaker-fixture.mjs";
import { gradeIcebreaker, summarize } from "./icebreaker-grade.mjs";

const path = process.argv[2];
const data = JSON.parse(readFileSync(path, "utf8"));
const byId = new Map(SIGNED_PERSONAS.map((p) => [p.id, p]));

for (const key of ["before", "after"]) {
  const r = data[key];
  for (const row of r.rows) {
    row.violations = gradeIcebreaker(row.text, byId.get(row.target), byId.get(row.candidate));
  }
  r.summary = summarize(r.rows);
  const s = r.summary;
  console.log(
    `${r.label.padEnd(12)} n=${String(s.total).padStart(3)}  ` +
      `attribution ${String(s.attributionErrors).padStart(2)} (${s.attributionErrorPct}%)  ` +
      `[theft ${s.theft} / false-claim ${s.falseClaim}]  ` +
      `briefing ${s.briefing} (${s.briefingPct}%)  clean ${s.cleanPct}%`,
  );
}
writeFileSync(path, JSON.stringify(data, null, 2));
for (const key of ["before", "after"]) {
  const bad = data[key].rows.filter((r) => r.violations.length);
  if (!bad.length) { console.log(`\n${data[key].label}: nothing flagged`); continue; }
  console.log(`\n--- ${data[key].label}: ${bad.length} flagged ---`);
  for (const b of bad.slice(0, 6)) console.log(`  [${b.violations.join(",")}] ${b.text.slice(0, 150)}`);
}
