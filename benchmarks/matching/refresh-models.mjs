/**
 * Snapshot Venice's model catalogue to `venice-models.json`.
 *
 * Cost is a headline number in this benchmark, and a model that is missing from
 * lib.mjs's hand-copied PRICING table costs exactly $0.0000 — which reads as
 * "free", not as "unknown". So prices are read from the API and committed, and
 * the run that used them records the snapshot date.
 *
 *   node refresh-models.mjs          # refresh + report drift vs the pinned table
 *   node refresh-models.mjs flash    # ...and list ids matching /flash/, cheapest first
 *
 * The grep is for the day a model "drops" and nobody knows what Venice calls it:
 * GLM 5.3 Flash is `z-ai-glm-5-3-flash`, but GLM 5.2 is `zai-org-glm-5-2` and
 * GLM 4.7 Flash is `zai-org-glm-4.7-flash` — three naming schemes in one family.
 */
import { writeFileSync } from "node:fs";
import { PRICING } from "./lib.mjs";

const KEY = process.env.VENICE_API_KEY;
if (!KEY) throw new Error("VENICE_API_KEY not set");

const res = await fetch("https://api.venice.ai/api/v1/models", {
  headers: { Authorization: `Bearer ${KEY}` },
});
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
const body = await res.json();
const out = { fetchedAt: new Date().toISOString(), data: body.data ?? [] };
writeFileSync("./venice-models.json", JSON.stringify(out, null, 1) + "\n");
console.log(`wrote venice-models.json — ${out.data.length} models, ${out.fetchedAt.slice(0, 10)}`);

// Drift report. The pinned table deliberately WINS over the snapshot so old cost
// figures stay reproducible; this is how you find out that it is now fiction.
let drift = 0;
for (const [id, p] of Object.entries(PRICING)) {
  const m = out.data.find((x) => x.id === id);
  if (!m) {
    console.log(`  ⚠ ${id}: pinned in PRICING but no longer offered by Venice`);
    drift++;
    continue;
  }
  const live = { in: m.model_spec?.pricing?.input?.usd, out: m.model_spec?.pricing?.output?.usd };
  if (live.in !== p.in || live.out !== p.out) {
    console.log(`  ⚠ ${id}: pinned $${p.in}/$${p.out} — Venice now $${live.in}/$${live.out}`);
    drift++;
  }
}
console.log(drift ? `${drift} pinned price(s) have drifted (pinned values still used).` : "pinned prices match Venice.");

// ── optional id search ───────────────────────────────────────────────────────
const needle = process.argv[2];
if (needle) {
  const re = new RegExp(needle, "i");
  const hits = out.data
    .filter((m) => re.test(m.id) || re.test(m.model_spec?.name ?? ""))
    .map((m) => ({
      id: m.id,
      in: m.model_spec?.pricing?.input?.usd,
      out: m.model_spec?.pricing?.output?.usd,
      ctx: m.model_spec?.availableContextTokens,
      schema: m.model_spec?.capabilities?.supportsResponseSchema,
      effort: (m.model_spec?.capabilities?.reasoningEffortOptions ?? []).join("|") || "-",
      privacy: m.model_spec?.privacy,
    }))
    .sort((a, b) => (a.in ?? 1e9) - (b.in ?? 1e9));
  console.log(`\n${hits.length} model(s) matching /${needle}/i, cheapest input first:\n`);
  console.log(["id", "$in", "$out", "ctx", "schema", "reasoning-effort", "privacy"].join("\t"));
  for (const h of hits) {
    console.log([h.id, h.in, h.out, h.ctx, h.schema ? "yes" : "NO", h.effort, h.privacy].join("\t"));
  }
  console.log(`\nthen: node bakeoff.mjs <id>`);
}
