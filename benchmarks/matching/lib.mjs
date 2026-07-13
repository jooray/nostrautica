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

const BASE = "https://api.venice.ai/api/v1";
const KEY = process.env.VENICE_API_KEY;
if (!KEY) throw new Error("VENICE_API_KEY not set");

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
  const body = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    venice_parameters: {
      include_venice_system_prompt: false,
      disable_thinking: true,
      strip_thinking_response: true,
    },
  };
  if (schema && useSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: schemaName ?? "out", strict: true, schema },
    };
  }
  const started = Date.now();
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text();
        // Retry transient; don't retry 4xx that are our fault (except 429).
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`${res.status} ${txt.slice(0, 200)}`);
          await sleep(2000 * Math.pow(1.7, attempt) + Math.random() * 800);
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
      };
      return { content, usage, latencyMs, raw: j };
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
  "deepseek-v4-pro": { in: 1.65, out: 3.301 },
  "mistral-small-3-2-24b-instruct": { in: 0.09375, out: 0.25 },
  "qwen3-235b-a22b-instruct-2507": { in: 0.15, out: 0.75 },
};
export function costUsd(model, usage) {
  const p = PRICING[model];
  if (!p) return 0;
  return (usage.promptTokens / 1e6) * p.in + (usage.completionTokens / 1e6) * p.out;
}
