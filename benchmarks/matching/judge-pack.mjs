/**
 * Blind judging pack — the half of model quality no metric catches.
 *
 *   node judge-pack.mjs                     # every model with a bake-off card
 *   node judge-pack.mjs modelA modelB       # just these
 *   node judge-pack.mjs --per-model 24      # sample size per model per kind
 *
 * recall@k says the right person is ranked first. It says nothing about whether
 * the sentence shown to that attendee is one a human would send. The 2026-07
 * benchmark judged that by hand, once, on a pack built by a one-off script — and
 * the grades died with the run, so the next model started from zero and the two
 * were never comparable.
 *
 * The fix is content-addressed grades. An item's id is the SHA-256 of its text,
 * so:
 *   • grading is append-only — regenerating the pack with a new model in it
 *     leaves every existing grade attached to the text it was given for;
 *   • only genuinely new items show up as ungraded, which is what makes adding
 *     the fourth model cheap;
 *   • a full re-grade (a better judge, a changed rubric) is `--regrade-all`,
 *     and it can be done over the WHOLE dataset at once, so all models are
 *     judged by the same judge on the same day. That is the property that makes
 *     cross-model prose comparison mean anything.
 *
 * Blinding is real: `pack.json` and `pack.md` carry no model attribution and the
 * items are interleaved by a fixed-seed shuffle. The mapping lives in `key.json`,
 * which the report joins AFTER grading.
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PERSONAS } from "./personas.mjs";
// The icebreaker arm's rows reference the FIXTURE's personas, which include
// derived shared-artifact clones (`p06-shares-all`) that do not exist in
// personas.mjs. Resolving them through PERSONAS alone printed
// "About p06-shares-all — undefined" with empty offers/seeks, which makes an
// icebreaker ungradeable: half the rubric is "is this grounded in the recipient's
// actual details", and the judge could not see them.
import { PERSONA_BY_ID } from "./icebreaker-fixture.mjs";
import { mulberry32, shuffle } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CARDS = join(here, "results", "bakeoff");
const JUDGING = join(here, "judging");
const P = new Map(PERSONAS.map((p) => [p.id, p]));

const argv = process.argv.slice(2);
const perModel = Number(argv[argv.indexOf("--per-model") + 1]) || 20;
const wanted = argv.filter((a) => !a.startsWith("--") && a !== String(perModel));
const SEED = 20260826;

const itemId = (text) => createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);

/** Grades recorded so far, read BEFORE sampling — see `keepGraded` below. */
const GRADES_PATH = join(here, "judging", "grades.json");
const existingGrades = existsSync(GRADES_PATH)
  ? JSON.parse(readFileSync(GRADES_PATH, "utf8"))
  : {};



/**
 * Compact, judge-facing view of a persona — enough to catch invented facts.
 *
 * `kind` decides WHICH version of the persona, and it is not a detail: the judge
 * must see exactly what the model saw, or the grade is about the wrong thing.
 *
 *  • reasoning items come from the scoring arm, which uses the plain personas.
 *    Showing the signed version there would put artifacts in front of the judge
 *    that the scoring model never saw, and an invented fact would read as a
 *    grounded one.
 *  • icebreaker items come from the attribution arm, whose personas each own an
 *    invented artifact — that ownership IS the thing under test. Resolving the
 *    SENDER through the plain personas hid their own artifact, so "I'm building
 *    Handbasket Rails" was unverifiable: the judge could not tell a correct
 *    claim from a stolen one, which is the single distinction this arm exists
 *    to make.
 */
function brief(id, kind) {
  const p = kind === "icebreaker" ? (PERSONA_BY_ID.get(id) ?? P.get(id)) : (P.get(id) ?? PERSONA_BY_ID.get(id));
  if (!p) throw new Error(`judge pack: cannot resolve persona ${id} — an item with no
    profile is not gradeable, so this fails loudly rather than shipping a blank`);
  const a = p.ai_profile;
  return {
    name: p.name,
    summary: a.summary,
    skills: a.skills, interests: a.interests, offers: a.offers, seeks: a.seeks,
  };
}

const cards = readdirSync(CARDS)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(CARDS, f), "utf8")))
  .filter((c) => (wanted.length ? wanted.includes(c.model) : true));
if (!cards.length) throw new Error(`no bake-off cards in ${CARDS} (run bakeoff.mjs first)`);

const gold = JSON.parse(readFileSync(join(here, "gold-pairs.json"), "utf8"));
const gkey = (a, b) => [a, b].sort().join("|");
const strong = new Set(gold.strong.map((g) => gkey(g.a, g.b)));
const medium = new Set(gold.medium.map((g) => gkey(g.a, g.b)));
const labelOf = (a, b) => (strong.has(gkey(a, b)) ? "strong" : medium.has(gkey(a, b)) ? "medium" : "weak");

/**
 * Stratified so the sample is not all easy pairs. A judge shown twenty
 * gold-strong reasonings grades every model 5/5: the interesting text is what a
 * model writes about two people who have little to say to each other.
 */
function stratifiedSample(items, n, keyOf, rng) {
  const groups = new Map();
  for (const it of items) {
    const k = keyOf(it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const keys = [...groups.keys()].sort();
  const out = [];
  // Already-graded items are drawn FIRST within their stratum. A grade is
  // otherwise only kept while its item happens to be redrawn, so anything that
  // moves the draw — a new model, a different --per-model, a fix to the sampler
  // — silently orphans work the judge already did. Seeding the sampler per model
  // (so adding a card stops resampling the others) did exactly that on its own:
  // 60 carried grades became 5.
  //
  // Preferring them keeps the pack the same SIZE while making judging effort
  // accumulate: an existing model contributes the items it was already judged
  // on, and only genuinely new work is ungraded. `--regrade-all` still re-judges
  // everything when the rubric or the judge changes.
  const shuffled = new Map(
    keys.map((k) => {
      const g = shuffle(groups.get(k), rng);
      const wasGraded = (x) => (existingGrades[itemId(x.text)] ? 0 : 1);
      return [k, [...g].sort((a, b) => wasGraded(a) - wasGraded(b))];
    }),
  );
  for (let i = 0; out.length < n; i++) {
    let progressed = false;
    for (const k of keys) {
      const g = shuffled.get(k);
      if (i < g.length) {
        out.push(g[i]);
        progressed = true;
        if (out.length >= n) break;
      }
    }
    if (!progressed) break;
  }
  return out;
}

/**
 * A sampling stream per (model, kind), NOT one shared stream.
 *
 * With a single stream, the models are sampled in directory order and each one
 * advances the RNG for the next — so adding a fourth card silently RESAMPLED
 * every model that sorts after it, and grades recorded against the old sample
 * stopped matching. That defeats the whole point of content-addressed ids:
 * adding a model is supposed to leave existing grades attached. Observed
 * directly — adding the two Qwen cards carried only 25 of 60 existing grades
 * forward; with per-stream seeding it is all of them.
 */
function streamFor(model, kind) {
  let h = SEED >>> 0;
  for (const c of `${model}|${kind}`) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  return mulberry32(h);
}
const items = [];

for (const card of cards) {
  // ── reasoning, from the full-190 run (the harder ranking, and the one every
  //    model has) ──────────────────────────────────────────────────────────────
  const runFile = join(here, "results",
    `${card.suite.prompt}_K${card.suite.k}_${card.model.replace(/[^a-zA-Z0-9._-]/g, "")}_seed${card.suite.seeds[0]}_full.json`);
  if (existsSync(runFile)) {
    const run = JSON.parse(readFileSync(runFile, "utf8"));
    const pool = run.edges
      .filter((e) => e.reasoning && e.reasoning.length > 15)
      .map((e) => ({
        kind: "reasoning", model: card.model, lang: "en",
        target: e.target, candidate: e.candidate,
        goldLabel: labelOf(e.target, e.candidate),
        score: e.score, text: e.reasoning,
      }));
    items.push(...stratifiedSample(pool, perModel, (x) => x.goldLabel, streamFor(card.model, "reasoning")));
  }

  // ── icebreakers, from the attribution arm (both languages) ────────────────
  if (card.artifacts?.icebreakerResult) {
    const f = join(here, card.artifacts.icebreakerResult);
    if (existsSync(f)) {
      const ice = JSON.parse(readFileSync(f, "utf8"));
      const pool = ice.runs.flatMap((r) =>
        r.rows.map((row) => ({
          kind: "icebreaker", model: card.model, lang: r.lang,
          target: row.target, candidate: row.candidate,
          goldLabel: labelOf(row.target, row.candidate),
          // The deterministic grade travels with the item but is NOT shown in
          // pack.md: a judge told "this one is already flagged THEFT" is not
          // grading blind any more.
          violations: row.violations,
          text: row.text,
        })),
      );
      items.push(...stratifiedSample(pool, perModel, (x) => `${x.lang}`, streamFor(card.model, "icebreaker")));
    }
  }
}

// Dedup by content: two models producing the same sentence is one item to grade.
const byId = new Map();
for (const it of items) {
  const id = itemId(it.text);
  if (!byId.has(id)) byId.set(id, { id, ...it, models: [] });
  byId.get(id).models.push(it.model);
}
const all = shuffle([...byId.values()], mulberry32(SEED + 1));

mkdirSync(JUDGING, { recursive: true });

// The blind pack: no model, no deterministic verdict.
const pack = all.map((it) => ({
  id: it.id,
  kind: it.kind,
  lang: it.lang,
  writtenFor: brief(it.target, it.kind),
  about: brief(it.candidate, it.kind),
  text: it.text,
}));
writeFileSync(join(JUDGING, "pack.json"), JSON.stringify(pack, null, 2) + "\n");

// The key: everything the report needs, written separately so it is possible to
// grade without seeing it.
writeFileSync(
  join(JUDGING, "key.json"),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      seed: SEED,
      perModel,
      models: cards.map((c) => c.model),
      items: Object.fromEntries(all.map((it) => [it.id, {
        models: it.models, kind: it.kind, lang: it.lang,
        target: it.target, candidate: it.candidate,
        goldLabel: it.goldLabel, score: it.score ?? null,
        violations: it.violations ?? null,
      }])),
    },
    null, 2,
  ) + "\n",
);

// A readable pack, because the judge here is a language model reading a file.
const graded = existingGrades;
const regradeAll = argv.includes("--regrade-all");
const todo = pack.filter((it) => regradeAll || !graded[it.id]);

const lines = [
  "# Blind judging pack",
  "",
  `${pack.length} items, ${todo.length} ungraded${regradeAll ? " (--regrade-all: every item listed)" : ""}.`,
  "Model identity is not in this file. Grade each item 1-5 and write",
  "`judging/grades.json` as `{ \"<id>\": { \"score\": n, \"flags\": [...], \"note\": \"...\" } }`.",
  "",
  "## Rubric",
  "",
  "**reasoning** — shown to `writtenFor` about `about`, 1-2 sentences, host voice.",
  "  5 grounded in BOTH profiles, names a concrete thing to talk about, second person, no analytics",
  "  3 accurate but generic, or one-sided, or slightly analytical",
  "  1 invented facts, scoresplaining (\"high complementarity\"), or unusable as shown",
  "",
  "**icebreaker** — a message `writtenFor` SENDS to `about`; first one is pasted into a DM as-is.",
  "  5 sendable verbatim, concrete, correct ownership (\"my\" = writtenFor, \"your\" = about), natural in `lang`",
  "  3 sendable but bland, or awkward phrasing in `lang`",
  "  1 a briefing about the two of them, wrong ownership, or something no one would send",
  "",
  "Flags (optional, free-form array): `invented`, `scoresplain`, `briefing`, `ownership`,",
  "`generic`, `awkward-lang`, `unsendable`.",
  "",
];
for (const it of todo) {
  lines.push(`---`, ``, `### ${it.id}  (${it.kind}, ${it.lang})`, ``);
  lines.push(`**Written for ${it.writtenFor.name}** — ${it.writtenFor.summary}`);
  lines.push(`- offers: ${(it.writtenFor.offers ?? []).join("; ")}`);
  lines.push(`- seeks: ${(it.writtenFor.seeks ?? []).join("; ")}`);
  lines.push(``, `**About ${it.about.name}** — ${it.about.summary}`);
  lines.push(`- offers: ${(it.about.offers ?? []).join("; ")}`);
  lines.push(`- seeks: ${(it.about.seeks ?? []).join("; ")}`);
  lines.push(``, `> ${it.text.replace(/\n+/g, " ")}`, ``);
}
writeFileSync(join(JUDGING, "pack.md"), lines.join("\n"));

console.log(`models:   ${cards.map((c) => c.model).join(", ")}`);
console.log(`items:    ${pack.length} (${pack.filter((i) => i.kind === "reasoning").length} reasoning, ${pack.filter((i) => i.kind === "icebreaker").length} icebreaker)`);
console.log(`graded:   ${pack.length - todo.length} already, ${todo.length} to do`);
console.log(`wrote     judging/pack.json, judging/pack.md, judging/key.json`);
