/**
 * Has anything new shown up in Venice's catalogue?
 *
 *   node watch-new-models.mjs            # report new ids since the last run
 *   node watch-new-models.mjs --init     # (re)seed the baseline, report nothing
 *
 * Written for the hourly "did Qwen 3.8 Flash drop yet" check, but deliberately
 * not hardcoded to that: it reports EVERY new model id and flags the interesting
 * ones. Guessing the name in advance is a losing game — in the GLM family alone
 * Venice ships `zai-org-glm-5-2`, `zai-org-glm-4.7-flash` and `z-ai-glm-5-3-flash`,
 * three schemes for one vendor. A watcher that greps for "qwen-3-8-flash" would
 * miss `qwen-3-8-flash-preview`, `qwen3-8-flash` or `qwen-3-8-turbo`.
 *
 * State lives in `.model-watch.json`, separate from `venice-models.json`, which
 * is the pinned pricing snapshot — a watcher that rewrote the price basis every
 * hour would quietly move the cost figures in published results.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const STATE = join(here, ".model-watch.json");
const KEY = process.env.VENICE_API_KEY;
if (!KEY) throw new Error("VENICE_API_KEY not set");

const res = await fetch("https://api.venice.ai/api/v1/models", { headers: { Authorization: `Bearer ${KEY}` } });
if (!res.ok) {
  // Non-fatal by design: the hourly job should log a bad hour and move on, not
  // die and take the schedule with it.
  console.log(`CHECK-FAILED ${res.status} — catalogue unreachable, nothing concluded`);
  process.exit(0);
}
const data = (await res.json()).data ?? [];

const spec = (m) => ({
  id: m.id,
  in: m.model_spec?.pricing?.input?.usd ?? null,
  out: m.model_spec?.pricing?.output?.usd ?? null,
  ctx: m.model_spec?.availableContextTokens ?? null,
  schema: m.model_spec?.capabilities?.supportsResponseSchema ?? null,
  privacy: m.model_spec?.privacy ?? null,
  name: m.model_spec?.name ?? m.id,
});
const now = data.map(spec);
const nowIds = new Set(now.map((m) => m.id));

const prev = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
const save = () =>
  writeFileSync(STATE, JSON.stringify({ checkedAt: new Date().toISOString(), ids: [...nowIds].sort() }, null, 1) + "\n");

if (!prev || process.argv.includes("--init")) {
  save();
  console.log(`BASELINE ${nowIds.size} models recorded. No comparison on a first run.`);
  process.exit(0);
}

const seen = new Set(prev.ids);
const added = now.filter((m) => !seen.has(m.id));
const removed = [...seen].filter((id) => !nowIds.has(id));
save();

// "Interesting" = plausibly the thing being waited for. Broad on purpose: a
// false positive costs one glance, a false negative costs the whole point of
// checking hourly.
const interesting = (m) => /qwen/i.test(m.id) && (/flash|lite|mini|turbo|air/i.test(m.id) || /-3-?8/.test(m.id));

if (!added.length && !removed.length) {
  console.log(`NO-CHANGE ${nowIds.size} models, unchanged since ${prev.checkedAt.slice(0, 16).replace("T", " ")}`);
  process.exit(0);
}
for (const m of added.filter(interesting)) {
  console.log(`NEW-INTERESTING ${m.id} | ${m.name} | $${m.in}/$${m.out} per Mtok | ctx ${m.ctx} | schema ${m.schema} | privacy ${m.privacy}`);
}
for (const m of added.filter((x) => !interesting(x))) {
  console.log(`NEW ${m.id} | $${m.in}/$${m.out} | schema ${m.schema} | privacy ${m.privacy}`);
}
for (const id of removed) console.log(`GONE ${id}`);
