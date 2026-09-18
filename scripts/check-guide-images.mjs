/**
 * Every image a guide references must exist on disk, in BOTH themes.
 *
 * Why this exists: a missing <img> renders as blank space. The docs link checker
 * in build-docs.mjs validates links between pages and never looks at images, and
 * `screenshot-refresh.mjs` exits 0 when a stem is skipped rather than captured
 * (a skip is a normal outcome there, since the coordinator double can go inert
 * mid-run). So a guide can ship pointing at images nobody ever took, and the
 * only symptom is a gap on the page.
 *
 * Both themes, because the docs generator pairs them: an image reference ending
 * `-light.png` renders BOTH it and its `-dark.png` sibling, and CSS picks one.
 * A missing dark sibling is invisible in light mode and a hole in dark mode.
 *
 * Usage:
 *   node scripts/check-guide-images.mjs              # every docs/*.md
 *   node scripts/check-guide-images.mjs de es        # only the -de / -es guides
 *
 * Exits non-zero with a per-file report when anything is missing.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");

/** Markdown image references, as `images/<dir>/<stem>.png` paths. */
export function imageRefs(markdown) {
  const out = new Set();
  for (const m of markdown.matchAll(/!\[[^\]]*\]\((images\/[^)\s]+\.png)\)/g)) out.add(m[1]);
  // HTML <img src="..."> too, in case a guide ever needs one.
  for (const m of markdown.matchAll(/<img[^>]+src="(images\/[^"]+\.png)"/g)) out.add(m[1]);
  return [...out];
}

/**
 * The docs generator's theme pairing rule: a `-light.png` reference also renders
 * its `-dark.png` sibling. Returns every file that must exist for one reference.
 */
export function requiredFiles(ref) {
  return ref.endsWith("-light.png") ? [ref, ref.replace(/-light\.png$/, "-dark.png")] : [ref];
}

function guideFiles(suffixes) {
  return readdirSync(DOCS)
    .filter((f) => f.endsWith(".md") && statSync(join(DOCS, f)).isFile())
    .filter((f) => {
      if (!suffixes.length) return true;
      return suffixes.some((s) => f.includes(`-${s}.md`) || (s === "en" && !/-[a-z]{2}\.md$/.test(f)));
    })
    .sort();
}

function main(suffixes) {
  let missingTotal = 0;
  let checked = 0;
  for (const file of guideFiles(suffixes)) {
    const md = readFileSync(join(DOCS, file), "utf8");
    const refs = imageRefs(md);
    if (!refs.length) continue;
    const missing = [];
    for (const ref of refs) {
      for (const need of requiredFiles(ref)) {
        if (!existsSync(join(DOCS, need))) missing.push(need);
      }
    }
    checked += refs.length;
    if (missing.length) {
      missingTotal += missing.length;
      console.log(`\n${file}: ${missing.length} missing image(s) of ${refs.length} referenced`);
      for (const m of [...new Set(missing)].sort()) console.log(`  ${m}`);
    }
  }
  if (missingTotal === 0) {
    console.log(`OK: every referenced image exists in both themes (${checked} references checked).`);
    return 0;
  }
  console.log(`\n${missingTotal} missing image file(s).`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
