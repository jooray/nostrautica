/**
 * Stamp `?v=<content hash>` onto every local CSS/JS reference in web/index.html.
 *
 * The landing page is served with `cache-control: no-cache` while its assets get
 * `max-age=86400`, so a returning visitor can hold a day-old style.css and app.js
 * against freshly-updated markup. That is not a theoretical skew: shipping the
 * five-language switcher produced exactly it. The new HTML carried a <select> the
 * old CSS had no rule for, so both switchers rendered at once, and the old app.js
 * still had LANGS = ["en","sk","cs"], so clicking DE or ES fell through setLang's
 * unknown-language guard and silently loaded English.
 *
 * A query string is enough because the HTML itself is never cached: change the
 * file, the hash changes, the URL changes, the browser refetches. No build step
 * and no filename rewriting, which keeps the "no build step" property the landing
 * page is written around.
 *
 * Run after editing any landing asset:  node scripts/stamp-landing-assets.mjs
 * The deploy build fails if you forget (see checkLandingAssetVersions in
 * build-docs.mjs), so forgetting is loud rather than silent.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Short content hash. 8 hex chars is plenty to detect a change. */
export function assetHash(absPath) {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex").slice(0, 8);
}

/**
 * Every local CSS/JS reference in the landing HTML, with the version it declares.
 * Absolute URLs, protocol-relative URLs and data: URIs are skipped: they are not
 * ours to version.
 */
export function landingCodeRefs(html) {
  const out = [];
  const re = /(?:href|src)="([^"]+\.(?:css|js))(\?v=([0-9a-f]+))?"/g;
  for (const m of html.matchAll(re)) {
    const [, path, , declared] = m;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(path)) continue;
    out.push({ path, declared: declared ?? null, full: m[0] });
  }
  return out;
}

function main() {
  const htmlPath = join(ROOT, "web", "index.html");
  let html = readFileSync(htmlPath, "utf8");
  let changed = 0;
  for (const ref of landingCodeRefs(html)) {
    const abs = join(ROOT, "web", ref.path);
    if (!existsSync(abs)) {
      console.error(`  missing asset, not stamped: web/${ref.path}`);
      continue;
    }
    const hash = assetHash(abs);
    if (ref.declared === hash) {
      console.log(`  unchanged  ${ref.path}?v=${hash}`);
      continue;
    }
    const attr = ref.full.startsWith("href") ? "href" : "src";
    html = html.replace(ref.full, `${attr}="${ref.path}?v=${hash}"`);
    console.log(`  stamped    ${ref.path}?v=${hash}${ref.declared ? ` (was ${ref.declared})` : ""}`);
    changed++;
  }
  if (changed) {
    writeFileSync(htmlPath, html);
    console.log(`\n${changed} reference(s) restamped in web/index.html`);
  } else {
    console.log("\nnothing to do; every reference already matches its file");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
