/**
 * Unblind and aggregate the subjective grades.
 *
 *   node judge-report.mjs           # per-model means + coverage
 *   node judge-report.mjs --items   # every graded item, unblinded
 *
 * Reports coverage first and loudly. A mean over 6 of 40 items is not a grade,
 * it is a rumour, and the failure mode this guards against is a model looking
 * better than another because fewer of its items happened to be graded.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const J = join(here, "judging");
const key = JSON.parse(readFileSync(join(J, "key.json"), "utf8"));
const grades = existsSync(join(J, "grades.json"))
  ? JSON.parse(readFileSync(join(J, "grades.json"), "utf8"))
  : {};

const rows = [];
for (const [id, meta] of Object.entries(key.items)) {
  const g = grades[id];
  // An item produced by two models (identical text) counts for both.
  for (const model of meta.models) {
    rows.push({ id, model, kind: meta.kind, lang: meta.lang, goldLabel: meta.goldLabel,
      graded: !!g, score: g?.score ?? null, flags: g?.flags ?? [], note: g?.note ?? "" });
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (n, d = 2) => (typeof n === "number" && isFinite(n) ? n.toFixed(d) : "-");

const models = [...new Set(rows.map((r) => r.model))].sort();
const kinds = ["reasoning", "icebreaker"];

console.log(`pack built ${key.builtAt?.slice(0, 10)}  seed ${key.seed}  models: ${key.models.join(", ")}\n`);
console.log(["model", "kind", "graded/total", "mean", "1-2", "5s", "top flags"].join("\t"));
for (const m of models) {
  for (const k of kinds) {
    const mine = rows.filter((r) => r.model === m && r.kind === k);
    if (!mine.length) continue;
    const g = mine.filter((r) => r.graded);
    const flags = {};
    for (const r of g) for (const f of r.flags) flags[f] = (flags[f] ?? 0) + 1;
    const top = Object.entries(flags).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([f, n]) => `${f}×${n}`).join(" ");
    console.log([
      m.slice(0, 24), k, `${g.length}/${mine.length}`, fmt(mean(g.map((r) => r.score))),
      g.filter((r) => r.score <= 2).length, g.filter((r) => r.score === 5).length, top || "-",
    ].join("\t"));
  }
}

const ungraded = rows.filter((r) => !r.graded);
if (ungraded.length) {
  const byModel = {};
  for (const r of ungraded) byModel[r.model] = (byModel[r.model] ?? 0) + 1;
  console.log(`\n⚠ ungraded: ${Object.entries(byModel).map(([m, n]) => `${m} ${n}`).join(", ")}` +
    ` — means above are over graded items only. Run judge-pack.mjs and grade the rest.`);
}

if (process.argv.includes("--items")) {
  console.log(`\n${"=".repeat(72)}`);
  for (const r of rows.filter((x) => x.graded).sort((a, b) => a.score - b.score)) {
    console.log(`${r.score}  ${r.model.padEnd(24)} ${r.kind}/${r.lang}/${r.goldLabel}  ${r.flags.join(",") || "-"}  ${r.note}`);
  }
}
