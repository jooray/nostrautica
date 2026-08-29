/**
 * Per-call latency, measured the only way it means anything: SERIALLY.
 *
 *   node latency-probe.mjs <model> [n] [--refresh]
 *
 * The scoring arms run 16 calls in flight because wall-clock is all that
 * concurrency costs them — every batch is independent and cached. But Venice
 * answers requests past a model's concurrency allowance with an immediate 429
 * rather than queueing them, so `complete()` sleeps in a backoff and the
 * "latency" those arms record is the retry schedule, not the model. That is how
 * deepseek-v4-flash-0731 came out at a p50 of 28.9s in a full-190 run and 6.2s
 * in a subset run of the same prompt on the same day.
 *
 * So speed gets its own arm: N calls, one at a time, same K=10 shape production
 * uses, no cache (a replayed call has no latency). The result is written to
 * results/LATENCY_<model>.json and reused unless --refresh, so re-running the
 * bake-off does not re-bill it.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PERSONAS } from "./personas.mjs";
import { BATCHED_PROMPTS, batchedSchema } from "./prompts.mjs";
import { complete, costUsd } from "./lib.mjs";
import { sampleScoringUser } from "./suite-prompts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = process.argv[2];
const N = Number(process.argv.find((a, i) => i > 2 && !a.startsWith("--"))) || 6;
const REFRESH = process.argv.includes("--refresh");
if (!MODEL) throw new Error("usage: node latency-probe.mjs <model> [n] [--refresh]");

const out = join(here, "results", `LATENCY_${MODEL.replace(/[^a-zA-Z0-9._-]/g, "")}.json`);

export async function latencyProbe(model = MODEL, n = N, refresh = REFRESH) {
  const file = join(here, "results", `LATENCY_${model.replace(/[^a-zA-Z0-9._-]/g, "")}.json`);
  if (!refresh && existsSync(file)) {
    const prev = JSON.parse(readFileSync(file, "utf8"));
    if (prev.calls >= n) return prev;
  }
  const schema = batchedSchema();
  const rows = [];
  for (let i = 0; i < n; i++) {
    // A different target each call, so the number is not one persona's quirk and
    // Venice's prompt cache cannot flatter the tail.
    const target = PERSONAS[i % PERSONAS.length];
    const batch = PERSONAS.filter((p) => p.id !== target.id).slice(0, 10);
    const r = await complete({
      model, system: BATCHED_PROMPTS.BP3, user: sampleScoringUser(target, batch),
      schema, schemaName: "batch_scores", temperature: 0.3, maxTokens: 4000,
    });
    rows.push({
      latencyMs: r.latencyMs,
      promptTokens: r.usage.promptTokens,
      completionTokens: r.usage.completionTokens,
      reasoningTokens: r.usage.reasoningTokens ?? 0,
      cachedTokens: r.usage.cachedTokens ?? 0,
      strictParseOk: r.strictParseOk,
      finishReason: r.finishReason,
    });
    process.stderr.write(`  latency ${i + 1}/${n}: ${r.latencyMs}ms  out=${r.usage.completionTokens}` +
      `${r.usage.reasoningTokens ? ` (reasoning ${r.usage.reasoningTokens})` : ""}\n`);
  }
  const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  const q = (f) => lat[Math.min(lat.length - 1, Math.floor(f * lat.length))];
  const usage = {
    promptTokens: rows.reduce((a, r) => a + r.promptTokens, 0),
    completionTokens: rows.reduce((a, r) => a + r.completionTokens, 0),
    reasoningTokens: rows.reduce((a, r) => a + r.reasoningTokens, 0),
  };
  const result = {
    model, calls: n, measuredAt: new Date().toISOString(), concurrency: 1, k: 10,
    latencyP50: q(0.5), latencyP95: q(0.95),
    latencyMin: lat[0], latencyMax: lat[lat.length - 1],
    meanCompletionTokens: Math.round(usage.completionTokens / n),
    meanReasoningTokens: Math.round(usage.reasoningTokens / n),
    // Tokens per second of output — what actually separates a "fast" model from
    // one that is merely terse.
    outputTokensPerSec: Math.round((usage.completionTokens / (lat.reduce((a, b) => a + b, 0) / 1000)) * 10) / 10,
    strictJsonOk: rows.filter((r) => r.strictParseOk).length,
    truncated: rows.filter((r) => r.finishReason === "length").length,
    costUsd: costUsd(model, { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }),
    rows,
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await latencyProbe();
  console.log(`${r.model}: p50 ${r.latencyP50}ms  p95 ${r.latencyP95}ms  ` +
    `(min ${r.latencyMin} / max ${r.latencyMax}), ${r.meanCompletionTokens} out tok/call` +
    `${r.meanReasoningTokens ? ` incl. ${r.meanReasoningTokens} reasoning` : ""}, ` +
    `${r.outputTokensPerSec} tok/s, strict JSON ${r.strictJsonOk}/${r.calls}`);
  console.log(`wrote ${out.replace(here + "/", "")}`);
}
