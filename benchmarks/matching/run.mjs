/**
 * Benchmark runner.
 *
 * Usage:
 *   node run.mjs --model <id> --prompt BP0|BP1|BP2 --k <K> [--seed N] [--subset]
 *   node run.mjs --pairwise --model <id> [--subset]      (P0 reference, K=1)
 *
 * Batched mode: for each TARGET persona, its candidate set (all others, or the
 * eval subset restricted to that target) is split into shuffled batches of size K.
 * One LLM call per batch. Per-candidate results are cached and merged into a flat
 * list of directional edges {target, candidate, similarity, complementarity, score,
 * reasoning}. Also records slotIndex (position within its batch) for position-bias.
 *
 * Every batch call is cached by (model, prompt, K, target, sorted candidate ids,
 * seed) so reruns never re-bill.
 */
import { PERSONAS, EVENT } from "./personas.mjs";
import {
  P0_PAIRWISE, PAIRWISE_SCHEMA, BATCHED_PROMPTS, batchedSchema,
} from "./prompts.mjs";
import {
  complete, parseJsonLoose, profileText, normalizeScore, cacheKey, readCache,
  writeCache, mulberry32, shuffle, pool, costUsd,
} from "./lib.mjs";
import { readFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] === undefined ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const MODEL = args.model;
const CACHE_DIR = "./cache/calls";
const P = new Map(PERSONAS.map((p) => [p.id, p]));

// Models that reject strict json_schema response_format (schema=false in /models).
const NO_SCHEMA = new Set(); // all our chosen models report schema=true; kept for safety.

const EVENT_HDR = [
  `EVENT: ${EVENT.title}`,
  `ABOUT: ${EVENT.summary}`,
  `TOPICS: ${EVENT.hashtags.join(", ")}`,
].join("\n");

// ── eval subset (60 pairs: all gold + stratified negatives, seeded) ───────────
export function evalSubsetPairs() {
  const gold = JSON.parse(readFileSync("./gold-pairs.json", "utf8"));
  const set = new Set();
  const add = (a, b) => set.add([a, b].sort().join("|"));
  for (const g of gold.strong) add(g.a, g.b);
  for (const g of gold.medium) add(g.a, g.b);
  const goldCount = set.size;
  // stratified negatives to reach 60, seeded
  const ids = PERSONAS.map((p) => p.id);
  const rng = mulberry32(20260713);
  const all = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) all.push([ids[i], ids[j]]);
  const negs = shuffle(all.filter(([a, b]) => !set.has([a, b].sort().join("|"))), rng);
  for (const [a, b] of negs) {
    if (set.size >= 60) break;
    add(a, b);
  }
  return { pairs: [...set].map((s) => s.split("|")), goldCount };
}

/** For a target, which candidate ids to score (full = all others; subset = only
 *  those the target is paired with in the eval subset). */
function candidatesFor(targetId, subset) {
  if (!subset) return PERSONAS.filter((p) => p.id !== targetId).map((p) => p.id);
  const { pairs } = evalSubsetPairs();
  const s = new Set();
  for (const [a, b] of pairs) {
    if (a === targetId) s.add(b);
    if (b === targetId) s.add(a);
  }
  return [...s];
}

function candidateBlock(ids) {
  return ids
    .map((id, i) => `CANDIDATE ${i} (${P.get(id).name}):\n${profileText(P.get(id).ai_profile)}`)
    .join("\n\n");
}

// ── batched scoring for one target ────────────────────────────────────────────
async function scoreTargetBatched(targetId, K, promptKey, seed, subset) {
  const target = P.get(targetId);
  const candIds = candidatesFor(targetId, subset);
  // Shuffle candidate order per (target, seed) so position bias averages out and
  // we can correlate slot index vs score.
  const rng = mulberry32(seed * 1000003 + hashId(targetId));
  const ordered = shuffle(candIds, rng);
  const system = BATCHED_PROMPTS[promptKey];
  const schema = batchedSchema();

  const edges = [];
  let usageAcc = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let latencies = [];
  let formatFails = 0;
  let missingCandidates = 0;
  let calls = 0;

  const batches = [];
  for (let i = 0; i < ordered.length; i += K) batches.push(ordered.slice(i, i + K));

  for (const batch of batches) {
    const ck = cacheKey(["batch", MODEL, promptKey, K, seed, targetId, batch]);
    let cached = readCache(CACHE_DIR, ck);
    if (!cached) {
      const user = [
        EVENT_HDR,
        "",
        `TARGET (${target.name}):`,
        profileText(target.ai_profile),
        "",
        `CANDIDATES (score the target against each; there are ${batch.length}):`,
        candidateBlock(batch),
        "",
        `Return a JSON object {"matches": [...]} with exactly ${batch.length} entries, one per candidate index 0..${batch.length - 1}.`,
      ].join("\n");
      let content, usage, latencyMs;
      try {
        ({ content, usage, latencyMs } = await complete({
          model: MODEL, system, user, schema, schemaName: "batch_scores",
          temperature: 0.3, maxTokens: Math.min(8000, 500 + batch.length * 350),
          useSchema: !NO_SCHEMA.has(MODEL),
        }));
      } catch (e) {
        // Do NOT cache transient rate-limit / server errors as permanent failures.
        const msg = String(e);
        if (/\b429\b|\b5\d\d\b|too many/i.test(msg)) throw new Error(`transient after retries: ${msg.slice(0, 120)}`);
        cached = { error: msg.slice(0, 200), batch, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, latencyMs: 0 };
        writeCache(CACHE_DIR, ck, cached);
      }
      if (!cached) {
        let parsed, fail = false;
        try {
          const obj = parseJsonLoose(content);
          parsed = Array.isArray(obj) ? obj : obj.matches;
          if (!Array.isArray(parsed)) throw new Error("no matches array");
        } catch (e) {
          fail = true;
          parsed = [];
        }
        cached = { batch, usage, latencyMs, formatFail: fail, entries: parsed };
        writeCache(CACHE_DIR, ck, cached);
      }
    }
    calls++;
    usageAcc.promptTokens += cached.usage.promptTokens;
    usageAcc.completionTokens += cached.usage.completionTokens;
    usageAcc.totalTokens += cached.usage.totalTokens;
    if (cached.latencyMs) latencies.push(cached.latencyMs);
    if (cached.error || cached.formatFail) {
      formatFails++;
      continue;
    }
    // map entries by index; detect missing/duplicate
    const byIndex = new Map();
    for (const e of cached.entries) {
      const idx = typeof e.index === "number" ? e.index : e.candidate ?? e.i;
      if (idx >= 0 && idx < cached.batch.length && !byIndex.has(idx)) byIndex.set(idx, e);
    }
    for (let slot = 0; slot < cached.batch.length; slot++) {
      const candId = cached.batch[slot];
      const e = byIndex.get(slot);
      if (!e) {
        missingCandidates++;
        continue;
      }
      edges.push({
        target: targetId,
        candidate: candId,
        slotIndex: slot,
        batchSize: cached.batch.length,
        similarity: normalizeScore(e.similarity),
        complementarity: normalizeScore(e.complementarity),
        score: normalizeScore(e.score),
        reasoning: String(e.reasoning_for_target ?? e.reasoning ?? "").trim(),
      });
    }
  }
  return { edges, usage: usageAcc, latencies, formatFails, missingCandidates, calls };
}

// ── pairwise reference (K=1, P0 prompt) ───────────────────────────────────────
async function scoreTargetPairwise(targetId, subset) {
  const target = P.get(targetId);
  const candIds = candidatesFor(targetId, subset);
  const edges = [];
  let usageAcc = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let latencies = [], formatFails = 0, calls = 0;
  for (const candId of candIds) {
    // canonical A<B ordering so pairwise cache is shared across both targets
    const [a, b] = [targetId, candId].sort();
    const ck = cacheKey(["pairwise", MODEL, a, b]);
    let cached = readCache(CACHE_DIR, ck);
    if (!cached) {
      const user = [
        EVENT_HDR, "",
        `PERSON A:\n${profileText(P.get(a).ai_profile)}`, "",
        `PERSON B:\n${profileText(P.get(b).ai_profile)}`,
      ].join("\n");
      let content, usage, latencyMs, fail = false, parsed = {};
      try {
        ({ content, usage, latencyMs } = await complete({
          model: MODEL, system: P0_PAIRWISE, user, schema: PAIRWISE_SCHEMA,
          schemaName: "pair_score", temperature: 0.3, maxTokens: 1500,
        }));
        parsed = parseJsonLoose(content);
      } catch (e) {
        fail = true;
        usage = usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        latencyMs = latencyMs ?? 0;
      }
      cached = { a, b, usage, latencyMs, formatFail: fail, parsed };
      writeCache(CACHE_DIR, ck, cached);
    }
    calls++;
    usageAcc.promptTokens += cached.usage.promptTokens;
    usageAcc.completionTokens += cached.usage.completionTokens;
    usageAcc.totalTokens += cached.usage.totalTokens;
    if (cached.latencyMs) latencies.push(cached.latencyMs);
    if (cached.formatFail) { formatFails++; continue; }
    // directional: target is A or B
    const forTarget = targetId === cached.a ? cached.parsed.reasoning_for_a : cached.parsed.reasoning_for_b;
    edges.push({
      target: targetId, candidate: candId, slotIndex: 0, batchSize: 1,
      similarity: normalizeScore(cached.parsed.similarity),
      complementarity: normalizeScore(cached.parsed.complementarity),
      score: normalizeScore(cached.parsed.score),
      reasoning: String(forTarget ?? "").trim(),
    });
  }
  return { edges, usage: usageAcc, latencies, formatFails, missingCandidates: 0, calls };
}

function hashId(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h >>> 0;
}

async function main() {
  const subset = !!args.subset;
  const seed = args.seed ? Number(args.seed) : 1;
  const targets = PERSONAS.map((p) => p.id);
  let runLabel;
  const worker = args.pairwise
    ? (t) => scoreTargetPairwise(t, subset)
    : (t) => scoreTargetBatched(t, Number(args.k), args.prompt, seed, subset);
  runLabel = args.pairwise
    ? `pairwise|${MODEL}|${subset ? "subset" : "full"}`
    : `${args.prompt}|K${args.k}|${MODEL}|seed${seed}|${subset ? "subset" : "full"}`;

  const perTarget = await pool(targets, worker, 4);
  const edges = perTarget.flatMap((r) => r.edges);
  const usage = perTarget.reduce(
    (a, r) => ({
      promptTokens: a.promptTokens + r.usage.promptTokens,
      completionTokens: a.completionTokens + r.usage.completionTokens,
      totalTokens: a.totalTokens + r.usage.totalTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
  const latencies = perTarget.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const p = (q) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : 0);
  const formatFails = perTarget.reduce((a, r) => a + r.formatFails, 0);
  const missingCandidates = perTarget.reduce((a, r) => a + r.missingCandidates, 0);
  const calls = perTarget.reduce((a, r) => a + r.calls, 0);

  const out = {
    label: runLabel, model: MODEL, prompt: args.pairwise ? "P0" : args.prompt,
    k: args.pairwise ? 1 : Number(args.k), seed, subset,
    edges,
    stats: {
      calls, formatFails, missingCandidates,
      latencyP50: p(0.5), latencyP95: p(0.95),
      usage, costUsd: costUsd(MODEL, usage),
    },
  };
  const fname = `./results/${runLabel.replace(/[|]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "")}.json`;
  writeCache(".", fname.slice(2, -5), out); // writeCache adds .json
  console.log(JSON.stringify({ label: runLabel, ...out.stats, edges: edges.length }, null, 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
