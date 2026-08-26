/**
 * Shared library for the matching benchmark:
 *  - Venice OpenAI-compatible client (mirrors packages/coordinator venice.ts quirks)
 *  - seeded RNG (mulberry32) for reproducible shuffles / subsets
 *  - on-disk JSON cache keyed by (model, prompt, shape) so reruns are incremental
 *  - profileText() identical to scoring.ts
 *  - normalizeScore() identical to scoring.ts
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  modelProfile, recordProfile, isReasoningMandatory, snapshotPricing,
} from "./model-profiles.mjs";

const BASE = "https://api.venice.ai/api/v1";
// Checked where it is USED, not at import. Importing this module is what
// `DRY=1` (print the exact prompt bytes), `icebreaker-regrade.mjs`, and
// `icebreaker-compare.mjs` all do, and none of them touch the network — a
// top-level throw made every offline path require a key it never spends. That
// matters on a machine you are setting up: the cheapest way to check a harness
// works there is to run the parts that cost nothing.
const KEY = process.env.VENICE_API_KEY;
function requireKey() {
  if (!KEY) throw new Error("VENICE_API_KEY not set (only needed for calls that hit the API)");
  return KEY;
}

// ── seeded RNG ────────────────────────────────────────────────────────────────
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── scoring.ts parity ────────────────────────────────────────────────────────
export function profileText(p) {
  return [
    `Summary: ${p.summary}`,
    `Skills: ${p.skills.join(", ")}`,
    `Interests: ${p.interests.join(", ")}`,
    `Offers: ${p.offers.join(", ")}`,
    `Seeks: ${p.seeks.join(", ")}`,
  ].join("\n");
}
export function normalizeScore(v) {
  let x = typeof v === "number" && isFinite(v) ? v : 0;
  if (x > 1) x = x > 10 ? x / 100 : x / 10;
  return Math.max(0, Math.min(1, x));
}

// ── cache ────────────────────────────────────────────────────────────────────
export function cacheKey(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}
export function cachePath(dir, key) {
  return `${dir}/${key}.json`;
}
export function readCache(dir, key) {
  const p = cachePath(dir, key);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
export function writeCache(dir, key, val) {
  const p = cachePath(dir, key);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(val));
}

// ── Venice client ────────────────────────────────────────────────────────────
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Structured chat completion. Returns { value, usage, latencyMs, raw }.
 * schema optional — some models don't support response_schema; then we omit
 * response_format and rely on prompt-instructed JSON (parsed leniently).
 */
export async function complete({ model, system, user, schema, schemaName, temperature = 0.3, maxTokens = 4096, useSchema = true }) {
  // Production's shape by default. A model that refuses it is downgraded once,
  // on Venice's own 400, and the fact is persisted — see model-profiles.mjs.
  let profile = modelProfile(model);
  const buildBody = () => ({
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    venice_parameters: {
      include_venice_system_prompt: false,
      ...(profile.disableThinking ? { disable_thinking: true } : {}),
      strip_thinking_response: true,
    },
  });
  const body = buildBody();
  if (schema && useSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: schemaName ?? "out", strict: true, schema },
    };
  }
  const started = Date.now();
  let lastErr;
  // 12 attempts with the backoff capped, not 6 uncapped. Venice rejects requests
  // beyond a model's concurrency allowance with an immediate 429 rather than
  // queueing them, so under load a call is not slow — it is refused, repeatedly,
  // and 6 attempts of a 1.7^n backoff give up after about a minute. A lost call is
  // a lost BATCH of 30 graded openers, which is a hole in the sample; waiting is
  // free by comparison. The cap keeps the tail bounded (~3 min worst case) instead
  // of letting 1.7^11 turn one unlucky call into a four-minute sleep.
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      // A per-attempt deadline. `fetch` has none by default, so a connection
      // Venice never answers stalls that worker forever — and with the pool at
      // CONC=8 a bake-off can sit at "→ R3-order / sk" indefinitely with no
      // error and no progress, which is indistinguishable from a slow model.
      // 240s is ~2.5× the slowest honest call observed (a K=10 Slovak reverse
      // batch at ~95s), so it never fires on a working request.
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${requireKey()}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.REQUEST_TIMEOUT_MS || 240000)),
      });
      if (!res.ok) {
        const txt = await res.text();
        // "Reasoning is mandatory for this endpoint and cannot be disabled."
        // Not our fault and not transient — it means this model cannot be driven
        // the way production drives every other one. Downgrade, remember, retry
        // WITHOUT consuming an attempt: twelve backoffs on a deterministic 400
        // is two wasted minutes per call.
        if (isReasoningMandatory(res.status, txt) && profile.disableThinking) {
          recordProfile(model, { disableThinking: false }, "Venice 400: reasoning is mandatory for this endpoint");
          profile = modelProfile(model);
          Object.assign(body, buildBody());
          if (schema && useSchema) {
            body.response_format = {
              type: "json_schema",
              json_schema: { name: schemaName ?? "out", strict: true, schema },
            };
          }
          attempt--;
          continue;
        }
        // Retry transient; don't retry 4xx that are our fault (except 429).
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`${res.status} ${txt.slice(0, 200)}`);
          // Say so. This retry was silent, and silence here is indistinguishable
          // from a slow model: Venice answers concurrent requests for a busy model
          // with 429 "currently overloaded" within ~400ms, so a run with CONC well
          // above what the model is accepting looks like it is working — every
          // worker is simply asleep in the backoff. That cost hours before anyone
          // probed the endpoint directly. RETRY_QUIET=1 silences it again.
          if (!process.env.RETRY_QUIET) {
            console.error(`  [retry ${attempt + 1}/12] ${res.status} ${txt.slice(0, 90).replace(/\s+/g, " ")}`);
          }
          await sleep(Math.min(20000, 2000 * Math.pow(1.7, attempt)) + Math.random() * 800);
          continue;
        }
        throw new Error(`${res.status} ${txt.slice(0, 300)}`);
      }
      const j = await res.json();
      const content = j.choices?.[0]?.message?.content;
      const latencyMs = Date.now() - started;
      const usage = {
        promptTokens: j.usage?.prompt_tokens ?? 0,
        completionTokens: j.usage?.completion_tokens ?? 0,
        totalTokens: j.usage?.total_tokens ?? 0,
        // Billed even when `strip_thinking_response` hides them, and the whole
        // reason a "cheap per token" reasoning model can be dearer per call.
        reasoningTokens: j.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        cachedTokens: j.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      };
      // Does the raw body survive `JSON.parse` — which is what
      // providers/venice.ts does — or only parseJsonLoose? A model that wraps
      // strict-schema output in a ```json fence parses fine here and throws
      // ProviderContractError on every call in production. That difference is
      // invisible to every other metric, so it is measured.
      let strictParseOk = false;
      try {
        JSON.parse(content);
        strictParseOk = true;
      } catch {}
      return {
        content, usage, latencyMs, raw: j, strictParseOk,
        finishReason: j.choices?.[0]?.finish_reason ?? null,
        disableThinkingSent: !!profile.disableThinking,
      };
    } catch (e) {
      lastErr = e;
      await sleep(800 * (attempt + 1) + Math.random() * 400);
    }
  }
  throw lastErr;
}

/** Lenient JSON extraction: strips code fences, grabs the first {...} or [...] block. */
export function parseJsonLoose(text) {
  if (typeof text !== "string") throw new Error("no content");
  let t = text.trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {}
  // find first array or object
  const objStart = t.indexOf("{");
  const arrStart = t.indexOf("[");
  let start = -1;
  if (arrStart >= 0 && (objStart < 0 || arrStart < objStart)) start = arrStart;
  else start = objStart;
  if (start < 0) throw new Error("no JSON found");
  const open = t[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === open) depth++;
    else if (t[i] === close) {
      depth--;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1));
    }
  }
  throw new Error("unbalanced JSON");
}

// ── bounded-concurrency pool ─────────────────────────────────────────────────
export async function pool(items, worker, concurrency = 6) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

// ── pricing (from GET /models, usd per 1M tokens) ────────────────────────────
export const PRICING = {
  "zai-org-glm-5-2": { in: 1.4, out: 4.4 },
  "zai-org-glm-4.7-flash": { in: 0.125, out: 0.5 },
  "z-ai-glm-5-turbo": { in: 1.2, out: 4.0 },
  "gemini-3-flash-preview": { in: 0.7, out: 3.75 },
  "deepseek-v4-flash": { in: 0.138, out: 0.275 },
  // 0423 is deprecated (removed 2026-08-14, autoRemap:false); 0731 is Venice's
  // named replacement — same 284B/13B-active MoE, ~27% dearer per token.
  "deepseek-v4-flash-0731": { in: 0.175, out: 0.35 },
  "deepseek-v4-pro": { in: 1.65, out: 3.301 },
  "mistral-small-3-2-24b-instruct": { in: 0.09375, out: 0.25 },
  "qwen3-235b-a22b-instruct-2507": { in: 0.15, out: 0.75 },
};
/**
 * Pinned prices win; the `GET /models` snapshot fills the gaps.
 *
 * Pinned-wins is deliberate: every cost figure already published in
 * MATCHING-BENCHMARK.md was computed from this table, and a Venice reprice must
 * not silently rewrite a historical result. The snapshot is what makes a model
 * nobody has priced by hand cost something other than $0.0000 — which is how a
 * missing entry used to read.
 */
export function priceOf(model) {
  return PRICING[model] ?? snapshotPricing()[model] ?? null;
}
export function costUsd(model, usage) {
  const p = priceOf(model);
  if (!p) return 0;
  return (usage.promptTokens / 1e6) * p.in + (usage.completionTokens / 1e6) * p.out;
}
