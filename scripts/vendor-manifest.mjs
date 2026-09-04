#!/usr/bin/env node
/**
 * Integrity manifest for the vendored crypto (2026-09-04 audit).
 *
 * `packages/vendor/{marmot-ts,ts-mls}/lib` is the MLS engine and the Marmot layer
 * on top of it — the end-to-end encryption for group chat. It is COMMITTED BUILT
 * OUTPUT: no source, no build step, no lockfile entry, and (per the README) two
 * deliberate hand-edits, so it cannot be byte-compared against an upstream build
 * either. Nothing in CI looked at those bytes at all.
 *
 * That combination is the problem. 450 files of minified-adjacent JavaScript that
 * nobody diffs, in the one directory where a change is most valuable to an
 * attacker and least likely to be noticed in review. This does not prove the
 * bytes match upstream — only a reproducible vendoring pipeline could, and that is
 * a larger piece of work — but it makes any change to them IMPOSSIBLE TO LAND
 * SILENTLY, which is the property actually missing.
 *
 *   node scripts/vendor-manifest.mjs --check   # CI: fail if the bytes moved
 *   node scripts/vendor-manifest.mjs --write   # after a deliberate re-vendor
 *
 * When `--check` fails, that is not automatically a compromise — it is far more
 * likely someone re-vendored upstream. The required response is the same either
 * way: read the diff, satisfy yourself it is what you meant, update
 * `packages/vendor/README.md`'s commit pins and patch notes, then `--write`.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(REPO_ROOT, "packages/vendor/INTEGRITY.sha256");
/** Only `lib/` — `node_modules/` is pnpm's, and `package.json` is covered by the lockfile. */
const ROOTS = ["packages/vendor/marmot-ts/lib", "packages/vendor/ts-mls/lib"];

/** Every file under `dir`, recursively, as repo-relative POSIX paths, sorted. */
function walk(dir) {
  const out = [];
  const visit = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) visit(full);
      else out.push(relative(REPO_ROOT, full).split(sep).join("/"));
    }
  };
  visit(dir);
  return out;
}

function build() {
  const lines = [];
  for (const root of ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) throw new Error(`vendored path missing: ${root}`);
    for (const rel of walk(abs)) {
      const digest = createHash("sha256").update(readFileSync(join(REPO_ROOT, rel))).digest("hex");
      lines.push(`${digest}  ${rel}`);
    }
  }
  // Sorted by path so the manifest is stable across filesystems and reviewable
  // as a diff rather than as a blob.
  lines.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1));
  return lines.join("\n") + "\n";
}

const mode = process.argv[2] ?? "--check";
const current = build();

if (mode === "--write") {
  writeFileSync(MANIFEST, current);
  const count = current.trimEnd().split("\n").length;
  console.log(`[vendor] wrote ${count} digests → ${relative(REPO_ROOT, MANIFEST)}`);
  process.exit(0);
}

if (!existsSync(MANIFEST)) {
  console.error(`[vendor] no manifest at ${relative(REPO_ROOT, MANIFEST)} — run with --write`);
  process.exit(1);
}

const recorded = readFileSync(MANIFEST, "utf8");
if (recorded === current) {
  const count = current.trimEnd().split("\n").length;
  console.log(`[vendor] ${count} vendored files match the manifest`);
  process.exit(0);
}

// Report WHAT moved, not just that something did — the whole point is that a
// reviewer can act on this without re-deriving it themselves.
const parse = (text) =>
  new Map(
    text
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(66), l.slice(0, 64)]),
  );
const was = parse(recorded);
const now = parse(current);
const added = [...now.keys()].filter((p) => !was.has(p));
const removed = [...was.keys()].filter((p) => !now.has(p));
const changed = [...now.keys()].filter((p) => was.has(p) && was.get(p) !== now.get(p));

console.error("[vendor] VENDORED CRYPTO HAS CHANGED — this is the MLS/Marmot engine.");
for (const p of changed) console.error(`  changed  ${p}`);
for (const p of added) console.error(`  added    ${p}`);
for (const p of removed) console.error(`  removed  ${p}`);
console.error(
  "\nIf this was a deliberate re-vendor: read the diff, update packages/vendor/README.md's\n" +
    "commit pins and carried-patch notes, then run `node scripts/vendor-manifest.mjs --write`.\n" +
    "If it was not, do not merge it.",
);
process.exit(1);
