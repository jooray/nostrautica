/**
 * Per-model REQUEST PROFILES and pricing, so adding a model to the bake-off is a
 * model id and nothing else.
 *
 * Two things vary between Venice models in ways that silently wreck a run:
 *
 *  1. `venice_parameters.disable_thinking`. Every model benchmarked before
 *     2026-08-26 accepted it, so the harness (and `providers/venice.ts`) sent it
 *     unconditionally. `z-ai-glm-5-3-flash` answers a request carrying it with
 *     **HTTP 400 "Reasoning is mandatory for this endpoint and cannot be
 *     disabled."** — and because `complete()` retries anything that throws, an
 *     undetected 400 costs twelve attempts and ~2 minutes per call before the
 *     run dies. So: try WITH it (production's shape, and what every historical
 *     result was measured under), and on that specific 400 downgrade the model
 *     to `disableThinking: false`, persist the fact, and retry immediately.
 *     A future model that also refuses is handled without touching this file.
 *
 *  2. Price. `PRICING` in lib.mjs is a hand-copied table, which means a model
 *     that is not in it costs $0.0000 — a benchmark whose headline number is
 *     cost quietly reporting free. Prices here come from `GET /models`
 *     (snapshotted to `venice-models.json` by `refresh-models.mjs`), with the
 *     hand-copied table WINNING where it has an entry so that previously
 *     published cost figures stay reproducible even after Venice reprices.
 *
 * Profiles live in `model-profiles.json` — data, not code, because they are
 * discovered at runtime and a future run must not have to rediscover them.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PROFILES_PATH = join(here, "model-profiles.json");
const MODELS_PATH = join(here, "venice-models.json");

function loadJson(path, fallback) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

let profiles = loadJson(PROFILES_PATH, {});

/**
 * The request shape to use for a model. Defaults to production's shape — which
 * is the only honest default, since a model that cannot be driven the way
 * production drives it is a finding, not a configuration detail.
 */
export function modelProfile(model) {
  const p = profiles[model] ?? {};
  return { disableThinking: p.disableThinking !== false, ...p };
}

/** Record a discovered quirk. Idempotent; writes only when something changed. */
export function recordProfile(model, patch, reason) {
  const before = JSON.stringify(profiles[model] ?? null);
  profiles[model] = { ...(profiles[model] ?? {}), ...patch };
  if (reason) profiles[model].reason = reason;
  if (JSON.stringify(profiles[model]) === before) return;
  profiles[model].detectedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2) + "\n");
  console.error(`  [profile] ${model}: ${JSON.stringify(patch)} — ${reason ?? ""}`);
}

/** Venice's own 400 for "this model always thinks". Matched on text, not status. */
export function isReasoningMandatory(status, text) {
  return status === 400 && /reasoning is mandatory|cannot be disabled/i.test(String(text));
}

/** Prices from the snapshot, keyed by model id → {in, out} USD per 1M tokens. */
export function snapshotPricing() {
  const snap = loadJson(MODELS_PATH, null);
  const out = {};
  for (const m of snap?.data ?? []) {
    const pr = m.model_spec?.pricing;
    if (typeof pr?.input?.usd === "number" && typeof pr?.output?.usd === "number") {
      out[m.id] = { in: pr.input.usd, out: pr.output.usd };
    }
  }
  return out;
}

/** Everything else the snapshot knows, for the model card. */
export function snapshotSpec(model) {
  const snap = loadJson(MODELS_PATH, null);
  const m = (snap?.data ?? []).find((x) => x.id === model);
  if (!m) return null;
  return {
    name: m.model_spec?.name ?? model,
    contextTokens: m.model_spec?.availableContextTokens ?? null,
    maxCompletionTokens: m.model_spec?.maxCompletionTokens ?? null,
    privacy: m.model_spec?.privacy ?? null,
    supportsResponseSchema: m.model_spec?.capabilities?.supportsResponseSchema ?? null,
    supportsReasoning: m.model_spec?.capabilities?.supportsReasoning ?? null,
    defaultReasoningEffort: m.model_spec?.capabilities?.defaultReasoningEffort ?? null,
    snapshotAt: snap?.fetchedAt ?? null,
  };
}
