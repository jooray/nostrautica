/**
 * Generate docs/PROTOCOL-REGISTRY.md from the typed CUSTOM_KIND_REGISTRY
 * (audit §13.1). The registry is the single source of truth for the tables;
 * `pnpm gen:registry` builds the protocol package and writes the doc, and
 * registry.test.ts fails if the committed doc drifts from the registry.
 *
 * Run: pnpm gen:registry   (builds @nostrautica/protocol first, then this)
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const { renderRegistryDoc } = await import(
  resolve(REPO_ROOT, "packages/protocol/dist/registry.js")
);

const out = resolve(REPO_ROOT, "docs/PROTOCOL-REGISTRY.md");
writeFileSync(out, renderRegistryDoc());
console.log(`wrote ${out}`);
