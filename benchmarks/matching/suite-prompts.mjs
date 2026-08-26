/**
 * The exact bytes the bake-off suite sends, with a fingerprint.
 *
 * "Record the intermediary prompts" is not documentation — it is the only way a
 * result from August and a result from December are comparable. The scoring
 * prompt lives in this directory (BP3), but the icebreaker prompt is imported
 * from the BUILT coordinator, so it changes whenever `scoring.ts` changes and a
 * stale `dist/` silently benchmarks the previous release. Every card records
 * these hashes; `bakeoff-report.mjs` has nothing to say about a table whose rows
 * were measured under different prompts, so the hashes are how you notice.
 *
 *   node record-prompts.mjs      # writes results/bakeoff/PROMPTS.md
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PERSONAS, EVENT } from "./personas.mjs";
import { BATCHED_PROMPTS } from "./prompts.mjs";
import { profileText } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** run.mjs's user block, for one target and its batch — reproduced, not guessed. */
export function sampleScoringUser(target, batch) {
  return [
    `EVENT: ${EVENT.title}`,
    `ABOUT: ${EVENT.summary}`,
    `TOPICS: ${EVENT.hashtags.join(", ")}`,
    "",
    `TARGET (${target.name}):`,
    profileText(target.ai_profile),
    "",
    `CANDIDATES (score the target against each; there are ${batch.length}):`,
    batch.map((c, i) => `CANDIDATE ${i} (${c.name}):\n${profileText(c.ai_profile)}`).join("\n\n"),
    "",
    `Return a JSON object {"matches": [...]} with exactly ${batch.length} entries, one per candidate index 0..${batch.length - 1}.`,
  ].join("\n");
}

/**
 * @param {string[]} langs languages the icebreaker arm ran in
 * @returns {Promise<Array<{name, text, sha, source}>>}
 */
export async function suitePrompts(langs = ["sk", "en"]) {
  const target = PERSONAS[0];
  const batch = PERSONAS.slice(1, 11);
  const out = [
    { name: "scoring.system.BP3", source: "prompts.mjs", text: BATCHED_PROMPTS.BP3 },
    { name: "scoring.user.sample", source: "run.mjs (K=10 batch)", text: sampleScoringUser(target, batch) },
  ];

  // The icebreaker arm's prompts come from the built coordinator. Missing dist is
  // reported, not thrown: a scoring-only bake-off is still a valid card.
  try {
    const dist = await import(join(here, "../../packages/coordinator/dist/matching/scoring.js"));
    for (const lang of langs) {
      out.push({
        name: `icebreaker.system.${lang}`,
        source: "packages/coordinator/dist/matching/scoring.js reverseSystemPrompt() (LIVE)",
        // Through the coordinator's own builder, not by re-concatenating its
        // parts. Reconstructing it here meant the fingerprint kept reporting the
        // pre-2026-08-26 hash after the language reminder shipped — a drift
        // detector that cannot see the drift it exists for.
        text: dist.reverseSystemPrompt(lang),
      });
    }
    const shared = PERSONAS[0];
    const targets = PERSONAS.slice(1, 11);
    out.push({
      name: "icebreaker.user.sample",
      source: "buildReverseBatchUserBlock (LIVE)",
      text: dist.buildReverseBatchUserBlock(
        { title: EVENT.title, summary: EVENT.summary, hashtags: EVENT.hashtags ?? [], lang: "en" },
        shared.ai_profile, shared.name,
        targets.map((t) => ({ id: t.id, profile: t.ai_profile, name: t.name })),
      ),
    });
  } catch (e) {
    out.push({ name: "icebreaker.*", source: "UNAVAILABLE", text: `dist not built: ${e.message}` });
  }
  return out.map((p) => ({ ...p, sha: sha(p.text) }));
}

/** Just the hashes, for the card. */
export async function promptFingerprint(langs) {
  return Object.fromEntries((await suitePrompts(langs)).map((p) => [p.name, p.sha]));
}
