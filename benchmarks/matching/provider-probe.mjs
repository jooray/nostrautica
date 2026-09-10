/**
 * Deployability, answered by production's own code.
 *
 * Every other arm in this suite talks to Venice through `lib.mjs`, which is a
 * faithful-but-separate reimplementation of `providers/venice.ts`. Faithful is
 * not the same as identical, and the gap is where adoption decisions go wrong —
 * twice now:
 *
 *  1. 2026-08-26: the harness parsed leniently and production did not, so a
 *     model that fenced its JSON benchmarked at zero format failures and would
 *     have failed every production call.
 *  2. 2026-09-10: the reverse of it. `venice.ts` had SINCE learned to parse
 *     leniently (`parseModelJson`) and to probe `disable_thinking` per model,
 *     so the report's two standing blockers described code that no longer
 *     existed — and cleared `z-ai-glm-5-3-flash` for adoption. It then failed
 *     5 of 5 calls here, for a third reason nothing was measuring: its
 *     mandatory reasoning exhausts `batchMaxTokens(10)` and the response comes
 *     back `finish_reason=length`, which `venice.ts` rejects outright.
 *
 * The lesson both times is the same, so this arm stops re-deriving the answer:
 * it imports `VeniceLlm` and `scoreReverseBatch` from `packages/coordinator/dist`
 * and runs the real thing. If a call fails here, it fails in production — no
 * inference, no reimplementation to keep in sync.
 *
 * Usage (needs `pnpm --filter @nostrautica/coordinator build` first):
 *   VENICE_API_KEY=... node provider-probe.mjs <model> [calls] [--refresh]
 *
 * Deliberately small (default 5 calls): this answers a yes/no, not a rate. A
 * model that cannot complete five production calls does not need a sixth.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SIGNED_PERSONAS, buildReverseDenseCases } from "./icebreaker-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "../../packages/coordinator/dist");

/** The event block production would send; the fixture supplies the people. */
const EVENT = {
  title: "Plan B Konference",
  summary: "Bitcoin, freedom tech and cypherpunk practice.",
  hashtags: ["bitcoin", "cypherpunk"],
  lang: "sk",
};

/**
 * Classify a failure into something a reader can act on. The distinction that
 * matters is "the model cannot do this shape" (truncation, unparseable output,
 * a refused parameter) versus "the network had a bad minute" — only the first
 * is a deployability verdict.
 */
function classify(message) {
  // Environmental failures FIRST, and kept separate from every model verdict.
  // The first run of this tool scored the deployed model 0/3 and wrote the file
  // — it had been started somewhere without DNS. A probe that cannot reach
  // Venice has learned nothing about the model, and recording that as a
  // deployability failure is precisely the "produced a result rather than an
  // error" trap the rest of this suite is littered with guards against.
  if (/DNS resolution failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|fetch failed/i.test(message)) {
    return "unreachable";
  }
  if (/\b(401|403)\b|unauthori[sz]ed|invalid api key/i.test(message)) return "unauthorized";
  if (/finish_reason=length|truncated/i.test(message)) return "truncated";
  if (/not valid JSON/i.test(message)) return "unparseable";
  if (/reasoning is mandatory|cannot be disabled/i.test(message)) return "rejects-parameter";
  if (/timeout/i.test(message)) return "timeout";
  if (/contract|schema|validate/i.test(message)) return "schema";
  return "other";
}

/** Failures that say something about the ENVIRONMENT, not about the model. */
const ENVIRONMENTAL = new Set(["unreachable", "unauthorized"]);

export async function providerProbe(model, calls = 5, refresh = false) {
  const file = join(here, "results", `PROBE_${model.replace(/[^a-zA-Z0-9._-]/g, "")}.json`);
  if (!refresh && existsSync(file)) {
    const prev = JSON.parse(readFileSync(file, "utf8"));
    if (prev.calls >= calls) return prev;
  }

  const { VeniceLlm } = await import(join(DIST, "providers/venice.js"));
  const { ApiKeyPayment } = await import(join(DIST, "providers/payment.js"));
  const scoring = await import(join(DIST, "matching/scoring.js"));

  const apiKey = process.env.VENICE_API_KEY;
  if (!apiKey) throw new Error("VENICE_API_KEY is not set");
  const llm = new VeniceLlm({ payment: new ApiKeyPayment(apiKey), requirePrivate: false });

  // The reverse batch at K=10: production's default batch size, and the shape
  // with the largest output budget — so the one a model fails first.
  const cases = buildReverseDenseCases(10).slice(0, calls);
  const rows = [];
  for (const [i, kase] of cases.entries()) {
    const targets = kase.targets.map((p) => ({ id: p.id, profile: p.ai_profile, name: p.name }));
    const t0 = Date.now();
    try {
      const res = await scoring.scoreReverseBatch(
        llm,
        model,
        EVENT,
        kase.shared.ai_profile,
        targets,
        Math.random,
        kase.shared.name,
      );
      rows.push({
        ok: true,
        ms: Date.now() - t0,
        scored: res.scores.size,
        asked: targets.length,
        missing: res.missing.length,
      });
      console.log(
        `  call ${i + 1}/${cases.length}: OK in ${((Date.now() - t0) / 1000).toFixed(0)}s — ` +
          `${res.scores.size}/${targets.length} scored`,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      rows.push({ ok: false, ms: Date.now() - t0, kind: classify(message), message: message.slice(0, 300) });
      console.log(
        `  call ${i + 1}/${cases.length}: FAIL in ${((Date.now() - t0) / 1000).toFixed(0)}s — ` +
          `${classify(message)}: ${message.slice(0, 120)}`,
      );
    }
  }

  const ok = rows.filter((r) => r.ok).length;
  const kinds = {};
  for (const r of rows) if (!r.ok) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  // Refuse to publish a verdict the run did not actually establish. Throwing
  // (rather than writing a file with a caveat inside it) is deliberate: the
  // report reads these files as authority, and a caveat in a field nobody
  // renders is not a safeguard.
  const environmental = rows.filter((r) => !r.ok && ENVIRONMENTAL.has(r.kind)).length;
  if (environmental > 0) {
    throw new Error(
      `probe could not reach the provider (${environmental}/${rows.length} calls: ` +
        `${Object.keys(kinds).filter((k) => ENVIRONMENTAL.has(k)).join(", ")}) — ` +
        `no verdict recorded. Check VENICE_API_KEY and network access, then re-run.`,
    );
  }
  // A missing entry is a pair that never gets scored, so a model that "succeeds"
  // while dropping targets is only partly usable — recorded, not hidden.
  const asked = rows.filter((r) => r.ok).reduce((a, r) => a + r.asked, 0);
  const scored = rows.filter((r) => r.ok).reduce((a, r) => a + r.scored, 0);
  const out = {
    model,
    calls: rows.length,
    ok,
    failed: rows.length - ok,
    kinds,
    entryYield: asked ? Math.round((scored / asked) * 1000) / 10 : null,
    latencyMsP50: [...rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? null,
    at: new Date().toISOString(),
    rows,
  };
  mkdirSync(join(here, "results"), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const model = process.argv[2];
  if (!model) throw new Error("usage: node provider-probe.mjs <model> [calls] [--refresh]");
  const n = Number(process.argv.find((a, i) => i > 2 && !a.startsWith("--"))) || 5;
  const r = await providerProbe(model, n, process.argv.includes("--refresh"));
  console.log(
    `\n${r.model}: ${r.ok}/${r.calls} calls succeeded through providers/venice.ts` +
      (r.entryYield !== null ? ` — ${r.entryYield}% of requested entries scored` : ""),
  );
  if (r.failed) console.log(`failure kinds: ${JSON.stringify(r.kinds)}`);
  console.log(`wrote results/PROBE_${r.model.replace(/[^a-zA-Z0-9._-]/g, "")}.json`);
  // Fixture personas are the same ones every other arm uses; assert that so a
  // future fixture edit cannot silently change what "production shape" means.
  if (SIGNED_PERSONAS.length < 20) console.warn("⚠ fixture shrank — probe is no longer the documented shape");
}
