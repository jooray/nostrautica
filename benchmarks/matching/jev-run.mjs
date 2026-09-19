/**
 * Jev (Venice "System One" decision model) as the pair scorer — EXPERIMENT.
 *
 * Jev is not a chat model. POST /decisions takes a `state` and a map of typed
 * `questions` (noul = P(yes), choice, score = probability-weighted rubric level)
 * and returns typed judgments — no prose, so there is no `reasoning_for_target`
 * here; every edge's reasoning is "". Input tokens only are billed ($0.042/Mtok,
 * output $0), and the state is billed ONCE per request however many questions
 * ride on it (probe 2026-09-19: +~20 input tokens per extra question).
 *
 * Two shapes, both writing results/*.json in the exact edge format run.mjs
 * writes, so `node evaluate.mjs` scores them beside every historical row:
 *
 *   node jev-run.mjs --shape pair  [--seed N] [--subset]
 *       one request per DIRECTED pair (target, candidate); state is the same
 *       EVENT/TARGET/CANDIDATE text block BP3 sees; questions: score (5-level
 *       rubric lifted from BP3's anchors), similarity, complementarity, and a
 *       noul "should meet". 380 requests for the full 20 personas.
 *   node jev-run.mjs --shape batch --k 10 [--seed N] [--subset]
 *       one request per (target, batch of K candidates): structured JSON state
 *       {event, target, candidates[]} and K score questions each naming
 *       `candidates[i]`. Candidate order shuffled per (target, seed) exactly as
 *       run.mjs does, so slotIndex/position bias is measured the same way.
 *
 * Each run writes TWO result files from the same calls: the primary ranks by the
 * rubric score (level/4 → 0..1), the `-noul` twin ranks by the yes/no probability,
 * so the two question types can be compared without paying twice.
 *
 * Cache: cache/jev/<hash>.json, raw response body kept (README: store the bytes
 * the verdict came from, not just the verdict).
 */
import { PERSONAS, EVENT } from "./personas.mjs";
import { profileText, cacheKey, readCache, writeCache, mulberry32, shuffle, pool } from "./lib.mjs";
import { readFileSync } from "node:fs";

// Same 60-pair eval subset run.mjs builds (all gold + seeded stratified
// negatives). Inlined rather than imported: run.mjs calls its main() at module
// load, so importing it here ran a phantom chat-completions sweep with an
// undefined model — 20 failed calls that, together with 429 retries, tripped
// Venice's ">50 failed attempts" 30 s key lockout (2026-09-19).
function evalSubsetPairs() {
  const gold = JSON.parse(readFileSync("./gold-pairs.json", "utf8"));
  const set = new Set();
  const add = (a, b) => set.add([a, b].sort().join("|"));
  for (const g of gold.strong) add(g.a, g.b);
  for (const g of gold.medium) add(g.a, g.b);
  const ids = PERSONAS.map((p) => p.id);
  const rng = mulberry32(20260713);
  const all = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) all.push([ids[i], ids[j]]);
  const negs = shuffle(all.filter(([a, b]) => !set.has([a, b].sort().join("|"))), rng);
  for (const [a, b] of negs) { if (set.size >= 60) break; add(a, b); }
  return { pairs: [...set].map((x) => x.split("|")) };
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] === undefined ? true : arr[i + 1]]);
    return acc;
  }, []),
);
const MODEL = "jev-latest";
const PRICE_IN = 0.042; // usd per 1M input tokens (GET /models 2026-09-19); output is $0
const CACHE_DIR = "./cache/jev";
const SHAPE = args.shape ?? "pair";
const K = Number(args.k ?? 10);
const SEED = args.seed ? Number(args.seed) : 1;
const SUBSET = !!args.subset;
const RUBRIC = args.rubric ?? "R5";
const P = new Map(PERSONAS.map((p) => [p.id, p]));

// ── rubric: BP3's score anchors, as ordered levels (lowest → highest) ─────────
const RUBRICS = {
  R5: {
    score: [
      "No real reason to meet",
      "Weak: only vague topical overlap",
      "Plausible: some overlap but no sharp need met",
      "Strong one-directional or clearly useful fit",
      "Near-perfect mutual fit: each solves the other's stated need",
    ],
    similarity: ["Nothing in common", "Slight overlap", "Moderate overlap", "Strong overlap of interests, background or goals", "Near-identical"],
    complementarity: ["Not at all", "Slightly", "Moderately", "Strongly: one has much of what the other needs", "Perfectly: each has exactly what the other seeks"],
  },
};
const R = RUBRICS[RUBRIC];
if (!R) throw new Error(`unknown rubric ${RUBRIC}`);
const toUnit = (score, levels) => Math.max(0, Math.min(1, score / (levels.length - 1)));

const SCORE_INSTR = (who) =>
  `How valuable would it be for ${who.target} to meet ${who.cand} at this event, considering what the event is for? ` +
  `A meeting is high-value when one person's seeks is met by the other's offers or skills, in either direction. ` +
  `Ground the judgement in the actual profile text only.`;
const SIM_INSTR = (who) => `How much do ${who.target} and ${who.cand} share interests, background, or goals?`;
const COMP_INSTR = (who) =>
  `How much do the skills and roles of ${who.target} and ${who.cand} complete each other for this event: one has what the other needs?`;
const MEET_INSTR = (who) => `Should ${who.target} make a point of meeting ${who.cand} at this event?`;

const EVENT_HDR = [`EVENT: ${EVENT.title}`, `ABOUT: ${EVENT.summary}`, `TOPICS: ${EVENT.hashtags.join(", ")}`].join("\n");

// ── client ────────────────────────────────────────────────────────────────────
const KEY = process.env.VENICE_API_KEY;
if (!KEY) throw new Error("VENICE_API_KEY not set");
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
// Venice allows 100 decisions/min per key and, past 50 non-success responses,
// locks the key for 30 s. Pacing beats retrying: one request start per PACE_MS.
const PACE_MS = Number(process.env.PACE_MS || 620);
let nextSlot = 0;
async function pace() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + PACE_MS;
  if (at > now) await sleep(at - now);
}
async function decide(state, questions) {
  await pace();
  const started = Date.now();
  let lastErr;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const res = await fetch("https://api.venice.ai/api/v1/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, state, questions }),
        signal: AbortSignal.timeout(Number(process.env.REQUEST_TIMEOUT_MS || 60000)),
      });
      const txt = await res.text();
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`${res.status} ${txt.slice(0, 200)}`);
          if (!process.env.RETRY_QUIET) console.error(`  [retry ${attempt + 1}/12] ${res.status} ${txt.slice(0, 90).replace(/\s+/g, " ")}`);
          await sleep(Math.min(20000, 1500 * Math.pow(1.7, attempt)) + Math.random() * 500);
          continue;
        }
        throw new Error(`${res.status} ${txt.slice(0, 300)}`);
      }
      const j = JSON.parse(txt);
      return { json: j, latencyMs: Date.now() - started, usage: { promptTokens: j.usage?.input_tokens ?? 0, completionTokens: j.usage?.output_tokens ?? 0 } };
    } catch (e) {
      lastErr = e;
      await sleep(800 * (attempt + 1) + Math.random() * 400);
    }
  }
  throw lastErr;
}

function candidatesFor(targetId) {
  if (!SUBSET) return PERSONAS.filter((p) => p.id !== targetId).map((p) => p.id);
  const { pairs } = evalSubsetPairs();
  const s = new Set();
  for (const [a, b] of pairs) { if (a === targetId) s.add(b); if (b === targetId) s.add(a); }
  return [...s];
}
function hashId(id) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0; return h >>> 0; }
const ans = (j, id) => j?.answers?.[id];

// ── pair shape ────────────────────────────────────────────────────────────────
async function scoreTargetPair(targetId) {
  const target = P.get(targetId);
  const edges = [];
  const acc = { usage: { promptTokens: 0, completionTokens: 0 }, latencies: [], formatFails: 0, missingCandidates: 0, calls: 0 };
  for (const candId of candidatesFor(targetId)) {
    const cand = P.get(candId);
    const who = { target: `the TARGET (${target.name})`, cand: `the CANDIDATE (${cand.name})` };
    const state = [EVENT_HDR, "", `TARGET (${target.name}):`, profileText(target.ai_profile), "", `CANDIDATE (${cand.name}):`, profileText(cand.ai_profile)].join("\n");
    const questions = {
      score: { type: "score", instructions: SCORE_INSTR(who), criteria: R.score },
      similarity: { type: "score", instructions: SIM_INSTR(who), criteria: R.similarity },
      complementarity: { type: "score", instructions: COMP_INSTR(who), criteria: R.complementarity },
      should_meet: { type: "noul", instructions: MEET_INSTR(who) },
    };
    const ck = cacheKey(["jev-pair", MODEL, RUBRIC, SEED, targetId, candId, state, questions]);
    let cached = readCache(CACHE_DIR, ck);
    if (!cached) {
      try {
        const r = await decide(state, questions);
        cached = { targetId, candId, usage: r.usage, latencyMs: r.latencyMs, raw: r.json };
      } catch (e) {
        const msg = String(e);
        if (/\b429\b|\b5\d\d\b/.test(msg)) throw new Error(`transient after retries: ${msg.slice(0, 120)}`);
        cached = { targetId, candId, usage: { promptTokens: 0, completionTokens: 0 }, latencyMs: 0, error: msg.slice(0, 200) };
      }
      writeCache(CACHE_DIR, ck, cached);
    }
    acc.calls++;
    acc.usage.promptTokens += cached.usage.promptTokens;
    acc.usage.completionTokens += cached.usage.completionTokens;
    if (cached.latencyMs) acc.latencies.push(cached.latencyMs);
    const s = ans(cached.raw, "score"), si = ans(cached.raw, "similarity"), co = ans(cached.raw, "complementarity"), m = ans(cached.raw, "should_meet");
    if (cached.error || !s || !m) { acc.formatFails++; continue; }
    edges.push({
      target: targetId, candidate: candId, slotIndex: 0, batchSize: 1,
      similarity: toUnit(si?.score ?? 0, R.similarity), complementarity: toUnit(co?.score ?? 0, R.complementarity),
      score: toUnit(s.score, R.score), scoreNoul: m.noul, confidence: s.confidence, probabilities: s.probabilities, reasoning: "",
    });
  }
  return { edges, ...acc };
}

// ── batch shape ───────────────────────────────────────────────────────────────
async function scoreTargetBatch(targetId) {
  const target = P.get(targetId);
  const rng = mulberry32(SEED * 1000003 + hashId(targetId));
  const ordered = shuffle(candidatesFor(targetId), rng);
  const edges = [];
  const acc = { usage: { promptTokens: 0, completionTokens: 0 }, latencies: [], formatFails: 0, missingCandidates: 0, calls: 0 };
  const batches = [];
  for (let i = 0; i < ordered.length; i += K) batches.push(ordered.slice(i, i + K));
  for (const batch of batches) {
    const state = {
      event: { title: EVENT.title, about: EVENT.summary, topics: EVENT.hashtags },
      target: { name: target.name, ...target.ai_profile },
      candidates: batch.map((id, i) => ({ index: i, name: P.get(id).name, ...P.get(id).ai_profile })),
    };
    const questions = {};
    batch.forEach((id, i) => {
      const who = { target: "`target`", cand: `\`candidates[${i}]\` (${P.get(id).name})` };
      questions[`score_${i}`] = { type: "score", instructions: SCORE_INSTR(who) + ` Judge only candidates[${i}]; ignore the other candidates.`, criteria: R.score };
      questions[`meet_${i}`] = { type: "noul", instructions: MEET_INSTR(who) + ` Judge only candidates[${i}].` };
    });
    const ck = cacheKey(["jev-batch", MODEL, RUBRIC, K, SEED, targetId, batch, questions]);
    let cached = readCache(CACHE_DIR, ck);
    if (!cached) {
      try {
        const r = await decide(state, questions);
        cached = { targetId, batch, usage: r.usage, latencyMs: r.latencyMs, raw: r.json };
      } catch (e) {
        const msg = String(e);
        if (/\b429\b|\b5\d\d\b/.test(msg)) throw new Error(`transient after retries: ${msg.slice(0, 120)}`);
        cached = { targetId, batch, usage: { promptTokens: 0, completionTokens: 0 }, latencyMs: 0, error: msg.slice(0, 200) };
      }
      writeCache(CACHE_DIR, ck, cached);
    }
    acc.calls++;
    acc.usage.promptTokens += cached.usage.promptTokens;
    acc.usage.completionTokens += cached.usage.completionTokens;
    if (cached.latencyMs) acc.latencies.push(cached.latencyMs);
    if (cached.error) { acc.formatFails++; continue; }
    batch.forEach((candId, slot) => {
      const s = ans(cached.raw, `score_${slot}`), m = ans(cached.raw, `meet_${slot}`);
      if (!s || !m) { acc.missingCandidates++; return; }
      edges.push({
        target: targetId, candidate: candId, slotIndex: slot, batchSize: batch.length,
        similarity: 0, complementarity: 0,
        score: toUnit(s.score, R.score), scoreNoul: m.noul, confidence: s.confidence, probabilities: s.probabilities, reasoning: "",
      });
    });
  }
  return { edges, ...acc };
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const targets = PERSONAS.map((p) => p.id);
  const worker = SHAPE === "pair" ? scoreTargetPair : scoreTargetBatch;
  const conc = Number(process.env.CONC || 6);
  const per = await pool(targets, worker, conc);
  const edges = per.flatMap((r) => r.edges);
  const usage = per.reduce((a, r) => ({ promptTokens: a.promptTokens + r.usage.promptTokens, completionTokens: a.completionTokens + r.usage.completionTokens }), { promptTokens: 0, completionTokens: 0 });
  usage.totalTokens = usage.promptTokens + usage.completionTokens;
  usage.reasoningTokens = 0;
  const lat = per.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const pq = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : 0);
  const sum = (f) => per.reduce((a, r) => a + f(r), 0);
  const calls = sum((r) => r.calls);
  const stats = {
    calls, formatFails: sum((r) => r.formatFails), missingCandidates: sum((r) => r.missingCandidates),
    strictOkCalls: calls, strictKnownCalls: calls, veniceOkCalls: 0, veniceKnownCalls: 0,
    latencyP50: pq(0.5), latencyP95: pq(0.95), usage, costUsd: (usage.promptTokens / 1e6) * PRICE_IN,
  };
  const shapeTag = SHAPE === "pair" ? "JEVPAIR" : `JEVBATCH-K${K}`;
  const base = { model: MODEL, k: SHAPE === "pair" ? 1 : K, seed: SEED, subset: SUBSET, stats };
  const write = (variant, mapScore) => {
    const label = `${shapeTag}-${variant}|${RUBRIC}|${MODEL}|seed${SEED}|${SUBSET ? "subset" : "full"}`;
    const out = { label, prompt: `${shapeTag}-${variant}-${RUBRIC}`, ...base, edges: edges.map((e) => ({ ...e, score: mapScore(e) })) };
    const fname = `results/${label.replace(/[|]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "")}`;
    writeCache(".", fname, out);
    console.log(JSON.stringify({ label, ...stats, edges: edges.length }));
  };
  write("score", (e) => e.score);
  write("noul", (e) => e.scoreNoul);
}
main().catch((e) => { console.error(e); process.exit(1); });
