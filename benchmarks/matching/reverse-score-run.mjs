/**
 * Scoring quality of the REVERSE batch shape — the half of the question that the
 * icebreaker benchmark cannot answer.
 *
 * Why this exists: run.mjs measures recall@1/@3, strong/medium/weak separation and
 * ordering accuracy, but only for the FORWARD shape (one target, K candidates) and
 * only against the prompts in prompts.mjs. `scoreReverseBatch` — one shared person,
 * K targets, which is how production scores the last person to submit a profile —
 * has never been evaluated for score quality at all. So when the reverse prompt is
 * changed to fix icebreaker attribution, "did the scores move?" had no baseline to
 * be compared against. It does now.
 *
 * Same fixture, same gold labels and the same metrics as the forward benchmark
 * (evaluate.mjs reads the file this writes), so a reverse row can be read next to a
 * forward one. The personas are the PLAIN ones from personas.mjs, not the
 * signature-artifact clones the icebreaker fixture uses: gold-pairs.json is about
 * these profiles, and editing them would make the scores incomparable.
 *
 *   node reverse-score-run.mjs [model] [K] [variants] [seeds]
 *   e.g. node reverse-score-run.mjs deepseek-v4-flash 10 R2,R3 1,2
 *   CONC=n sets calls in flight. VENICE_API_KEY must be set; rebuild dist first.
 *   Results → results/REVERSE_<variant>_<model>_K<k>_seed<n>.json, then:
 *     node evaluate.mjs
 *
 * Two seeds per variant by default, and that is not padding: recall@1 has a
 * denominator of 20 (ten gold-strong pairs, both directions), so a single run moves
 * in 5% steps and one seed cannot tell a real shift from a reshuffle.
 */
import { PERSONAS, EVENT } from "./personas.mjs";
import { complete, parseJsonLoose, normalizeScore, cacheKey, readCache, writeCache, mulberry32, shuffle, pool, costUsd } from "./lib.mjs";
import { REVERSE_VARIANTS, buildReverseBatchUserBlock } from "./reverse-variants.mjs";

const MODEL = process.argv[2] || "deepseek-v4-flash";
const K = Number(process.argv[3] || 10);
const WANTED = (process.argv[4] || "R2,R3").split(",").map((s) => s.trim()).filter(Boolean);
const SEEDS = (process.argv[5] || "1,2").split(",").map((s) => Number(s.trim())).filter(Boolean);
// See the note in icebreaker-run.mjs: safe to raise because jobs are independent
// and the per-(shared, seed) shuffle is seeded, so edges come out in the same order
// at any concurrency — `pool` fills results by index, not by completion.
const CONC = Number(process.env.CONC || 16);
/** LIMIT=n scores only the first n shared people — a two-call plumbing probe. */
const LIMIT = Number(process.env.LIMIT || 0);
const CACHE_DIR = "./cache/calls";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matches"],
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "similarity", "complementarity", "score", "reasoning_for_target"],
        properties: {
          index: { type: "number" },
          similarity: { type: "number" },
          complementarity: { type: "number" },
          score: { type: "number" },
          reasoning_for_target: { type: "string" },
          icebreakers: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

/** Production's own builder, so the bytes measured are the bytes that ship. */
function liveUserBlock(shared, targets) {
  return buildReverseBatchUserBlock(
    { title: EVENT.title, summary: EVENT.summary, hashtags: EVENT.hashtags ?? [], lang: "en" },
    shared.ai_profile,
    shared.name,
    targets.map((t) => ({ id: t.id, profile: t.ai_profile, name: t.name })),
  );
}

function hashId(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h >>> 0;
}

/** Every (shared person, batch of targets) call for one seed. */
function jobsFor(seed) {
  const jobs = [];
  for (const shared of LIMIT ? PERSONAS.slice(0, LIMIT) : PERSONAS) {
    const others = PERSONAS.filter((p) => p.id !== shared.id);
    // Shuffled per (shared, seed) exactly as run.mjs does, so position bias averages
    // out across the run and corr(slot, score) is still meaningful.
    const ordered = shuffle(others, mulberry32(seed * 1000003 + hashId(shared.id)));
    for (let i = 0; i < ordered.length; i += K) jobs.push({ shared, targets: ordered.slice(i, i + K) });
  }
  return jobs;
}

async function runVariant(key, seed) {
  const v = REVERSE_VARIANTS[key];
  if (!v) throw new Error(`unknown variant ${key} (have ${Object.keys(REVERSE_VARIANTS)})`);
  const system = v.system("en");
  // A variant may change the output schema (R4 adds the per-entry role fields).
  // Nothing here reads them — the metrics come from `score`/`similarity`/
  // `complementarity` — but the schema must match the prompt or the model is being
  // asked for fields it was never told about, which is a different experiment.
  const schema = v.schema ? v.schema(SCHEMA) : SCHEMA;
  const edges = [];
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const latencies = [];
  let formatFails = 0;
  let missingCandidates = 0;
  let calls = 0;

  const results = await pool(
    jobsFor(seed),
    async ({ shared, targets }) => {
      const ck = cacheKey(["reverse-score", MODEL, key, K, seed, shared.id, targets.map((t) => t.id)]);
      let cached = readCache(CACHE_DIR, ck);
      if (!cached) {
        try {
          const { content, usage: u, latencyMs } = await complete({
            model: MODEL,
            system,
            user: v.user(liveUserBlock(shared, targets)),
            schema,
            schemaName: "reverse_batch_score",
            temperature: 0.3,
            // Ten entries of reasoning plus three icebreakers each overruns the
            // 4096 default, and a truncated response is a lost BATCH, not a lost row.
            maxTokens: 12000,
          });
          let entries = [];
          let formatFail = false;
          try {
            const obj = parseJsonLoose(content);
            entries = Array.isArray(obj) ? obj : obj.matches;
            if (!Array.isArray(entries)) throw new Error("no matches array");
          } catch {
            formatFail = true;
            entries = [];
          }
          cached = { usage: u, latencyMs, formatFail, entries };
        } catch (e) {
          // Transient failures must not be cached as a permanent zero-score batch.
          const msg = String(e);
          if (/\b429\b|\b5\d\d\b|too many/i.test(msg)) throw new Error(`transient after retries: ${msg.slice(0, 120)}`);
          cached = { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, latencyMs: 0, formatFail: true, entries: [], error: msg.slice(0, 200) };
        }
        writeCache(CACHE_DIR, ck, cached);
      }
      return { shared, targets, cached };
    },
    CONC,
  );

  for (const { shared, targets, cached } of results) {
    calls++;
    usage.promptTokens += cached.usage.promptTokens;
    usage.completionTokens += cached.usage.completionTokens;
    usage.totalTokens += cached.usage.totalTokens;
    if (cached.latencyMs) latencies.push(cached.latencyMs);
    if (cached.formatFail) {
      formatFails++;
      continue;
    }
    const byIndex = new Map();
    for (const e of cached.entries) {
      const idx = Number(e?.index);
      // 1-based into the ordered target list, as scoring.ts parses it.
      if (Number.isInteger(idx) && idx >= 1 && idx <= targets.length && !byIndex.has(idx)) byIndex.set(idx, e);
    }
    for (let slot = 0; slot < targets.length; slot++) {
      const e = byIndex.get(slot + 1);
      if (!e) {
        missingCandidates++;
        continue;
      }
      edges.push({
        // Directed exactly as the forward runs record it: target is the reader the
        // reasoning is addressed to, candidate is the person they would meet. In this
        // shape that means the SHARED person is the candidate for every edge, and
        // slotIndex is the TARGET's position in the list (the only position this
        // shape has to be biased by).
        target: targets[slot].id,
        candidate: shared.id,
        slotIndex: slot,
        batchSize: targets.length,
        similarity: normalizeScore(e.similarity),
        complementarity: normalizeScore(e.complementarity),
        score: normalizeScore(e.score),
        reasoning: String(e.reasoning_for_target ?? "").trim(),
      });
    }
  }

  latencies.sort((a, b) => a - b);
  const p = (q) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : 0);
  const label = `REVERSE_${v.label}|K${K}|${MODEL}|seed${seed}`;
  const out = {
    label,
    model: MODEL,
    prompt: `rev-${v.label}`,
    k: K,
    seed,
    subset: false,
    edges,
    stats: {
      calls,
      formatFails,
      missingCandidates,
      latencyP50: p(0.5),
      latencyP95: p(0.95),
      usage,
      costUsd: costUsd(MODEL, usage),
    },
  };
  writeCache("./results", `REVERSE_${v.label}_${MODEL}_K${K}_seed${seed}`, out);
  console.log(
    `${label}: ${edges.length} edges, ${calls} calls, ${formatFails} format-fails, ` +
      `${missingCandidates} missing, $${out.stats.costUsd.toFixed(4)}`,
  );
  return out;
}

for (const seed of SEEDS) {
  for (const key of WANTED) await runVariant(key, seed);
}
console.log("\nnow: node evaluate.mjs   (rows prefixed rev- are this shape)");
