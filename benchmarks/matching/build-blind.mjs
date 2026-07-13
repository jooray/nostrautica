/**
 * Build a BLIND reasoning-quality sample for human/self judging.
 *
 * Samples ~N pair-reasonings across the given runs, strips model/prompt identity,
 * shuffles order, and writes blind-reasonings.json (the shuffled items) plus
 * blind-key.json (item id -> {model,prompt,k,target,candidate,label}) which is NOT
 * consulted until after judging.
 *
 * Each item includes the TARGET and CANDIDATE full ai_profiles so the judge can
 * check specificity and invented-fact violations.
 *
 *   node build-blind.mjs run1.json run2.json ...   (files in results/)
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { PERSONAS } from "./personas.mjs";
import { mulberry32, shuffle } from "./lib.mjs";

const P = new Map(PERSONAS.map((p) => [p.id, p]));
const gold = JSON.parse(readFileSync("./gold-pairs.json", "utf8"));
const key = (a, b) => [a, b].sort().join("|");
const strongSet = new Set(gold.strong.map((g) => key(g.a, g.b)));
const mediumSet = new Set(gold.medium.map((g) => key(g.a, g.b)));
const labelOf = (a, b) => (strongSet.has(key(a, b)) ? "strong" : mediumSet.has(key(a, b)) ? "medium" : "weak");

const files = process.argv.slice(2);
if (!files.length) { console.error("pass result json filenames"); process.exit(1); }

const rng = mulberry32(424242);
const items = [];
for (const f of files) {
  const run = JSON.parse(readFileSync("./results/" + f, "utf8"));
  // sample a spread of labels: prefer strong+medium+some weak
  const edges = run.edges.filter((e) => e.reasoning && e.reasoning.length > 10);
  const byLbl = { strong: [], medium: [], weak: [] };
  for (const e of edges) byLbl[labelOf(e.target, e.candidate)].push(e);
  const pick = [
    ...shuffle(byLbl.strong, rng).slice(0, 7),
    ...shuffle(byLbl.medium, rng).slice(0, 5),
    ...shuffle(byLbl.weak, rng).slice(0, 3),
  ];
  for (const e of pick) {
    items.push({
      _model: run.model, _prompt: run.prompt, _k: run.k,
      _label: labelOf(e.target, e.candidate),
      target: e.target, candidate: e.candidate,
      targetName: P.get(e.target).name, candidateName: P.get(e.candidate).name,
      targetProfile: P.get(e.target).ai_profile,
      candidateProfile: P.get(e.candidate).ai_profile,
      reasoning: e.reasoning,
    });
  }
}

const shuffled = shuffle(items, rng);
const blind = shuffled.map((it, i) => ({
  id: i,
  targetName: it.targetName,
  targetProfile: it.targetProfile,
  candidateName: it.candidateName,
  candidateProfile: it.candidateProfile,
  reasoning: it.reasoning,
}));
const answerKey = shuffled.map((it, i) => ({
  id: i, model: it._model, prompt: it._prompt, k: it._k, label: it._label,
  target: it.target, candidate: it.candidate,
}));

writeFileSync("./blind-reasonings.json", JSON.stringify(blind, null, 2));
writeFileSync("./blind-key.json", JSON.stringify(answerKey, null, 2));
console.log(`wrote ${blind.length} blind items`);
