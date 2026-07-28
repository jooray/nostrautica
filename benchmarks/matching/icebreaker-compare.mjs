/**
 * Compare graded icebreaker runs and say whether the difference is real.
 *
 * Every table in the README so far has been counts side by side, read by eye —
 * which is how "1/171 vs 1/182" got written up as a change and how "8 vs 2" got
 * called a result. At these rates the eye is not qualified: the numerator is
 * single digits and the denominator is thousands, so the only honest way to
 * compare two arms is an exact test on the 2x2 table.
 *
 *   node icebreaker-compare.mjs results/A.json results/B.json ...
 *
 * Groups every run in every file by (variant, lang), pools rows, and prints each
 * arm's attribution-error rate with a 95% Clopper-Pearson interval, then every
 * pairwise Fisher exact test within a language. Files are read as saved; run
 * icebreaker-regrade.mjs first if the grader has changed since they were written.
 */
import { readFileSync } from "node:fs";
import { fisherExact, ciExact } from "./stats.mjs";

const files = process.argv.slice(2);
if (!files.length) throw new Error("usage: node icebreaker-compare.mjs <result.json...>");

/**
 * Which LLM call a row came from. Openers are not independent observations: one
 * call scores a whole batch, and when a batch inverts it tends to invert several
 * entries at once — in the first dense run, six of one arm's eighteen errors came
 * from a single call. Treating 858 openers as 858 independent draws would make
 * every p-value below smaller than it should be, so the call is also reported as
 * the unit of analysis.
 *
 * Reverse batches hold one shared person (stored as `candidate`) against many
 * targets; forward batches are the mirror. Either way the call is identified by
 * the fixed person plus the bucket and the repeat index.
 */
const clusterKey = (row) =>
  row.bucket?.startsWith("reverse-")
    ? `${row.bucket}|${row.candidate}|${row.rep ?? 0}`
    : `${row.bucket}|${row.target}|${row.rep ?? 0}`;

// ── load and pool ────────────────────────────────────────────────────────────
const arms = new Map(); // "label|lang" → {label, lang, n, errors, theft, falseClaim, briefing, grounded}
for (const f of files) {
  const data = JSON.parse(readFileSync(f, "utf8"));
  const runs = Array.isArray(data.runs) ? data.runs : [data.before, data.after].filter(Boolean);
  for (const r of runs) {
    const key = `${r.label}|${r.lang ?? "en"}`;
    const a = arms.get(key) ?? {
      label: r.label, lang: r.lang ?? "en", n: 0, errors: 0, theft: 0, falseClaim: 0, briefing: 0, grounded: 0,
      clusters: new Map(), entries: new Map(), files: new Set(),
    };
    for (const row of r.rows) {
      a.n++;
      const v = row.violations ?? [];
      const bad = v.includes("THEFT") || v.includes("FALSE_CLAIM");
      if (v.includes("THEFT")) a.theft++;
      if (v.includes("FALSE_CLAIM")) a.falseClaim++;
      if (v.includes("BRIEFING")) a.briefing++;
      if (bad) a.errors++;
      if (row.mentionsTarget || row.mentionsCandidate) a.grounded++;
      const ck = clusterKey(row);
      a.clusters.set(ck, (a.clusters.get(ck) ?? 0) + (bad ? 1 : 0));
      // Which distinct entries this call actually returned, for yieldStats.
      if (!a.entries.has(ck)) a.entries.set(ck, new Set());
      a.entries.get(ck).add(row.bucket?.startsWith("reverse-") ? row.target : row.candidate);
    }
    a.files.add(f.split("/").pop());
    arms.set(key, a);
  }
}
/** Calls, and how many of them produced at least one attribution error. */
const callStats = (a) => {
  const calls = a.clusters.size;
  const dirty = [...a.clusters.values()].filter((c) => c > 0).length;
  return { calls, dirty };
};

/**
 * Output completeness, which is a correctness property and not a nicety. The
 * reverse prompt must return one entry per target — a missing entry is a PAIR
 * THAT NEVER GETS SCORED, not a cosmetic shortfall — and each entry should carry
 * up to three openers, since the app pastes the first into a DM and the rest are
 * the user's alternatives. A variant that lowers the attribution rate by returning
 * less has not fixed anything; it has just given the grader less to mark. R4 was
 * caught this way, so the comparison reports it next to the error rate rather than
 * leaving it to whoever thinks to look.
 */
const yieldStats = (a) => {
  const entriesPerCall = new Map();
  for (const [ck, set] of a.entries) entriesPerCall.set(ck, set.size);
  const calls = entriesPerCall.size || 1;
  const entries = [...entriesPerCall.values()].reduce((s, v) => s + v, 0);
  return { entriesPerCall: entries / calls, openersPerEntry: entries ? a.n / entries : 0 };
};

const pct = (x) => `${(x * 100).toFixed(2)}%`;
console.log("\nATTRIBUTION ERRORS (theft + false claim), pooled per arm\n");
console.log(
  "arm".padEnd(20) + "lang".padEnd(6) + "n".padStart(6) + "err".padStart(6) + "rate".padStart(9) +
    "  95% CI".padEnd(20) + "theft".padStart(7) + "false".padStart(7) + "brief".padStart(7) + "  names-artifact",
);
const sorted = [...arms.values()].sort((x, y) => x.lang.localeCompare(y.lang) || x.label.localeCompare(y.label));
for (const a of sorted) {
  const [lo, hi] = ciExact(a.errors, a.n);
  console.log(
    a.label.padEnd(20) + a.lang.padEnd(6) + String(a.n).padStart(6) + String(a.errors).padStart(6) +
      pct(a.errors / a.n).padStart(9) + `  [${pct(lo)}, ${pct(hi)}]`.padEnd(20) +
      String(a.theft).padStart(7) + String(a.falseClaim).padStart(7) + String(a.briefing).padStart(7) +
      `  ${pct(a.grounded / a.n)}`,
  );
}

console.log("\nPER CALL — the independent unit. One call scores a whole batch, and batches");
console.log("invert several entries at once, so this is the number to trust.\n");
console.log("arm".padEnd(20) + "lang".padEnd(6) + "calls".padStart(7) + "  with>=1 error".padStart(15) + "  rate".padStart(9) + "   95% CI".padEnd(20) + " entries/call  openers/entry");
for (const a of sorted) {
  const { calls, dirty } = callStats(a);
  const y = yieldStats(a);
  const [lo, hi] = ciExact(dirty, calls);
  console.log(
    a.label.padEnd(20) + a.lang.padEnd(6) + String(calls).padStart(7) + String(dirty).padStart(15) +
      pct(dirty / calls).padStart(9) + `   [${pct(lo)}, ${pct(hi)}]`.padEnd(20) +
      y.entriesPerCall.toFixed(2).padStart(13) + y.openersPerEntry.toFixed(2).padStart(15),
  );
}

console.log("\nPAIRWISE (Fisher exact, two-sided), within language\n");
const byLang = new Map();
for (const a of sorted) byLang.set(a.lang, [...(byLang.get(a.lang) ?? []), a]);
const verdictOf = (p) => (p < 0.05 ? "SIGNIFICANT" : p < 0.1 ? "suggestive" : "not distinguishable");
for (const [lang, list] of byLang) {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const A = list[i];
      const B = list[j];
      const p = fisherExact(A.errors, A.n - A.errors, B.errors, B.n - B.errors);
      const ca = callStats(A);
      const cb = callStats(B);
      const pc = fisherExact(ca.dirty, ca.calls - ca.dirty, cb.dirty, cb.calls - cb.dirty);
      console.log(`${lang}  ${A.label} vs ${B.label}`);
      console.log(
        `      per opener: ${A.errors}/${A.n} vs ${B.errors}/${B.n}`.padEnd(52) +
          `p = ${p.toFixed(4)}   ${verdictOf(p)}`,
      );
      console.log(
        `      per call:   ${ca.dirty}/${ca.calls} vs ${cb.dirty}/${cb.calls}`.padEnd(52) +
          `p = ${pc.toFixed(4)}   ${verdictOf(pc)}   <- decisive`,
      );
    }
  }
}

// Languages pooled. Reported separately from the per-language rows above because
// pooling assumes the prompt effect is the same in both, which is exactly the
// assumption that broke in 2026-07-25 (a fix that was 0% in English and inverted
// every opener in Slovak). Read it as extra power, never as a replacement.
console.log("\nPOOLED ACROSS LANGUAGES (assumes one common effect — see the note in the source)\n");
const pooled = new Map();
for (const a of sorted) {
  const p = pooled.get(a.label) ?? { label: a.label, n: 0, errors: 0 };
  p.n += a.n;
  p.errors += a.errors;
  pooled.set(a.label, p);
}
const plist = [...pooled.values()];
for (const p of plist) {
  const [lo, hi] = ciExact(p.errors, p.n);
  console.log(
    p.label.padEnd(20) + String(p.n).padStart(6) + String(p.errors).padStart(6) +
      pct(p.errors / p.n).padStart(9) + `  [${pct(lo)}, ${pct(hi)}]`,
  );
}
console.log("");
for (let i = 0; i < plist.length; i++) {
  for (let j = i + 1; j < plist.length; j++) {
    const A = plist[i];
    const B = plist[j];
    const p = fisherExact(A.errors, A.n - A.errors, B.errors, B.n - B.errors);
    console.log(
      `${A.label} (${A.errors}/${A.n}) vs ${B.label} (${B.errors}/${B.n})`.padEnd(64) +
        `p = ${p.toFixed(4)}   ${p < 0.05 ? "SIGNIFICANT" : p < 0.1 ? "suggestive" : "not distinguishable"}`,
    );
  }
}
console.log("");
