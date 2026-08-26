/**
 * Write the suite's exact prompt bytes to results/bakeoff/PROMPTS.md.
 * Run after any change to prompts.mjs or a coordinator rebuild.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { suitePrompts } from "./suite-prompts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const prompts = await suitePrompts(["sk", "en"]);
const lines = [
  "# Bake-off suite — exact prompt bytes",
  "",
  `Generated ${new Date().toISOString().slice(0, 10)} by \`node record-prompts.mjs\`.`,
  "",
  "Every bake-off card records these hashes. A card whose hashes differ from the",
  "ones here was measured under a different prompt and is not comparable with the",
  "rows around it — the usual cause is a stale `packages/coordinator/dist`, which",
  "makes the icebreaker arm benchmark the PREVIOUS release's prompt.",
  "",
  "| prompt | sha256/16 | source |",
  "|---|---|---|",
  ...prompts.map((p) => `| \`${p.name}\` | \`${p.sha}\` | ${p.source} |`),
  "",
];
for (const p of prompts) {
  lines.push(`## \`${p.name}\``, "", `sha256/16 \`${p.sha}\` — ${p.source}`, "", "```text", p.text, "```", "");
}
mkdirSync(join(here, "results", "bakeoff"), { recursive: true });
const out = join(here, "results", "bakeoff", "PROMPTS.md");
writeFileSync(out, lines.join("\n"));
console.log(`wrote ${out.replace(here + "/", "")} — ${prompts.length} prompts`);
for (const p of prompts) console.log(`  ${p.sha}  ${p.name}`);
