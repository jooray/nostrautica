/**
 * Did the model write in the language the event is held in?
 *
 *   node language-adherence.mjs            # every ICEBREAKER_* result on disk
 *
 * Blind judging of a 15-item sample turned up openers that were in English, or
 * in CZECH, at a Slovak event. A 15-item sample cannot tell 20% from 47%, and
 * this is a defect worth a real denominator: every opener is already saved, the
 * event language is already recorded per arm, and — like the attribution grader
 * — the check is decidable by string match rather than by a judge.
 *
 * Czech and Slovak are close enough that "has diacritics" proves nothing, so the
 * test is EXCLUSIVE markers only: letters and function words that exist in one
 * language and not the other. A message with no marker either way is counted as
 * `undecided` and reported, never silently folded into the pass rate.
 *
 * This is a coarse instrument on purpose. It catches "wrote the wrong language",
 * which is a shipping defect. It says nothing about whether the Slovak is GOOD —
 * that is what the blind judge is for, and the two disagree usefully: a model
 * can score 100% here and still write `v súkromí scéne`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Letters that exist in exactly one of the two languages.
const CZECH_ONLY_CHARS = /[řěů]/i;
const SLOVAK_ONLY_CHARS = /[ľĺŕôä]/i;
// Function words that differ. Whole-word matched: "pro" is Czech but "profil"
// is both, and a substring test would call every Slovak profile Czech.
const CZECH_ONLY_WORDS =
  /\b(jsem|jsi|jsou|jak|jako|který|která|které|tvůj|tvá|tvé|můj|má|mé|hledám|bych|vypadá|zkušenosti|přístup|podělit|zaměření|protiklad|před|přesný|technice|rozumí|zdroje|článku)\b/i;
const SLOVAK_ONLY_WORDS =
  /\b(som|si|sú|ako|ktorý|ktorá|ktoré|tvoj|tvoja|tvoje|môj|moja|moje|hľadám|vyzerá|skúsenosti|prístup|zameranie|pred|presný|technike|rozumie|zdroje|článku|ťa|ťi|ňom|veď)\b/i;
// Enough English to be sure, for a message with no Central-European diacritics
// at all. Any ONE of these plus no diacritics is decisive in practice.
const ENGLISH_WORDS = /\b(the|and|you|your|I'm|I’m|how|what|would|about|looking|love|talk|thanks|hey|hi)\b/i;
const ANY_CE_DIACRITIC = /[áäčďéíĺľňóôŕřšťúůýžě]/i;

/** @returns {"target"|"english"|"czech"|"slovak"|"undecided"} */
export function detectLanguage(text, expected) {
  const cz = CZECH_ONLY_CHARS.test(text) || CZECH_ONLY_WORDS.test(text);
  const sk = SLOVAK_ONLY_CHARS.test(text) || SLOVAK_ONLY_WORDS.test(text);
  if (expected === "en") {
    // At an English event, Slavic diacritics are the anomaly.
    return ANY_CE_DIACRITIC.test(text) ? (cz && !sk ? "czech" : "slovak") : "target";
  }
  if (expected === "sk") {
    if (!ANY_CE_DIACRITIC.test(text) && ENGLISH_WORDS.test(text)) return "english";
    if (cz && !sk) return "czech";
    if (sk) return "target";
    return ANY_CE_DIACRITIC.test(text) ? "undecided" : "undecided";
  }
  return "undecided";
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// Guarded: bakeoff.mjs imports detectLanguage(), and an import that prints a
// 50-row table into the middle of someone else's output is its own small bug.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

function main() {
// Grouped by (model, variant, bucket, lang), because those are the axes that make
// two arms comparable. Pooling a model's R1 sparse run with another's R3 dense one
// and calling the difference a model difference is exactly the mistake this
// benchmark keeps having to un-make.
const ONLY_BUCKET = process.argv[2];
const files = readdirSync(join(here, "results")).filter((f) => f.startsWith("ICEBREAKER_") && f.endsWith(".json"));
const groups = new Map();
for (const f of files) {
  const j = JSON.parse(readFileSync(join(here, "results", f), "utf8"));
  for (const run of j.runs ?? []) {
    for (const r of run.rows ?? []) {
      if (ONLY_BUCKET && r.bucket !== ONLY_BUCKET) continue;
      const k = [j.model, run.label, r.bucket, run.lang].join("|");
      if (!groups.has(k)) {
        groups.set(k, { model: j.model, variant: run.label, bucket: r.bucket, lang: run.lang,
          n: 0, target: 0, english: 0, czech: 0, slovak: 0, undecided: 0 });
      }
      const g = groups.get(k);
      g.n++;
      g[detectLanguage(r.text, run.lang)]++;
    }
  }
}
const rows = [...groups.values()];

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "–");
console.log(["model", "variant", "bucket", "lang", "n", "in-language", "ENGLISH", "CZECH", "undecided"].join("\t"));
for (const r of rows.sort(
  (a, b) => a.bucket.localeCompare(b.bucket) || a.lang.localeCompare(b.lang) || a.model.localeCompare(b.model),
)) {
  const wrong = r.lang === "sk" ? r.english + r.czech : r.czech + r.slovak;
  console.log(
    [
      r.model.slice(0, 24), r.variant, r.bucket, r.lang, r.n,
      pct(r.n - wrong - r.undecided, r.n),
      r.lang === "sk" ? `${r.english} (${pct(r.english, r.n)})` : "–",
      r.lang === "sk" ? `${r.czech} (${pct(r.czech, r.n)})` : "–",
      `${r.undecided} (${pct(r.undecided, r.n)})`,
    ].join("\t"),
  );
}

// Per CALL as well as per opener, because the two say different things and only
// one of them is a valid unit for a significance test.
//
// deepseek-v4-flash-0731's English openers are not drift: of 48 Slovak calls, 3
// came back with ALL 30 openers in English and 45 with none — zero partial
// calls. Counting 1391 openers as 1391 independent observations turned a
// 3-versus-0 result into p = 9.5e-50; at the call level, where the openers
// actually are correlated, it is p = 0.0094. Same conclusion, honest size.
console.log("\nper CALL (the unit a significance test may use):");
console.log(["model", "lang", "calls", "fully-wrong", "partially-wrong"].join("\t"));
const callGroups = new Map();
for (const f of files) {
  const j = JSON.parse(readFileSync(join(here, "results", f), "utf8"));
  for (const run of j.runs ?? []) {
    for (const r of run.rows ?? []) {
      if (ONLY_BUCKET && r.bucket !== ONLY_BUCKET) continue;
      const gk = [j.model, run.label, r.bucket, run.lang].join("|");
      if (!callGroups.has(gk)) callGroups.set(gk, new Map());
      const calls = callGroups.get(gk);
      // Rows recorded before callId existed have to be clustered by inference,
      // and the right key depends on the SHAPE: a reverse call has one fixed
      // recipient (`candidate`) and ten varying senders, a forward call has one
      // fixed sender (`target`) and ten varying recipients. Using both fields
      // splits every call into ten, which is what made the 0423 arm report 1005
      // calls instead of 176 and would have made its clean record look thinner
      // than it is.
      const id =
        r.callId ??
        (r.bucket.startsWith("reverse-")
          ? `legacy|${f}|${r.candidate}|${r.rep}`
          : `legacy|${f}|${r.target}|${r.rep}`);
      if (!calls.has(id)) calls.set(id, { n: 0, wrong: 0 });
      const c = calls.get(id);
      c.n++;
      const d = detectLanguage(r.text, run.lang);
      if (run.lang === "sk" ? d === "english" || d === "czech" : d === "czech" || d === "slovak") c.wrong++;
    }
  }
}
for (const [gk, calls] of [...callGroups.entries()].sort()) {
  const [model, variant, bucket, lang] = gk.split("|");
  const all = [...calls.values()];
  const full = all.filter((c) => c.wrong === c.n).length;
  const part = all.filter((c) => c.wrong > 0 && c.wrong < c.n).length;
  if (!full && !part) continue;
  console.log([model.slice(0, 24), `${variant}/${bucket}/${lang}`, all.length,
    `${full} (${pct(full, all.length)})`, `${part} (${pct(part, all.length)})`].join("\t"));
}
}
