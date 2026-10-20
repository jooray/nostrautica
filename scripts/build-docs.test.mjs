/**
 * Tests for the docs-site generator's path handling (audit O7) and link checker
 * (audit O6). Pure-function tests — importing build-docs.mjs does NOT trigger a
 * build (the entry point is guarded on being invoked directly).
 *
 * Run: node --test scripts/build-docs.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveOutDir,
  checkInternalLinks,
  checkLandingAssets,
  langOf,
  alternatesOf,
  rewriteRepoLinks,
  REPO_BLOB,
  cleanOutDir,
  THEME_JS,
  DOCS_CSP,
} from "./build-docs.mjs";

const ROOT = "/repo/root";

test("resolveOutDir: default is <root>/docs-site-build", () => {
  assert.equal(resolveOutDir(ROOT, undefined), resolve(ROOT, "docs-site-build"));
});

test("resolveOutDir: relative arg resolves against root", () => {
  assert.equal(resolveOutDir(ROOT, "out"), resolve(ROOT, "out"));
  assert.equal(resolveOutDir(ROOT, "nested/out"), resolve(ROOT, "nested/out"));
  assert.equal(resolveOutDir(ROOT, "../sibling"), resolve(ROOT, "../sibling"));
});

test("resolveOutDir: absolute arg is honoured verbatim (audit O7)", () => {
  assert.equal(resolveOutDir(ROOT, "/tmp/docs-out"), "/tmp/docs-out");
  assert.equal(resolveOutDir(ROOT, "/var/www/docs"), "/var/www/docs");
  // The historical bug: join(root, "/abs") nailed it under root.
  assert.notEqual(resolveOutDir(ROOT, "/tmp/docs-out"), resolve(ROOT, "tmp/docs-out"));
});

test("checkInternalLinks: clean set has no errors", () => {
  const pages = new Map([
    ["a.html", `<h1 id="top">A</h1><a href="b.html#sec">to b</a><a href="#top">top</a>`],
    ["b.html", `<h2 id="sec">Sec</h2>`],
  ]);
  const { errors, warnings } = checkInternalLinks(pages);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("checkInternalLinks: missing page, missing anchor, missing same-page anchor", () => {
  const pages = new Map([
    ["a.html", `<a href="gone.html">x</a><a href="b.html#nope">y</a><a href="#bad">z</a>`],
    ["b.html", `<h1 id="ok">ok</h1>`],
  ]);
  const { errors } = checkInternalLinks(pages);
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => e.includes("gone.html")));
  assert.ok(errors.some((e) => e.includes("#nope")));
  assert.ok(errors.some((e) => e.includes("#bad")));
});

test("checkInternalLinks: .md links (unpublished areas) are warnings, not errors", () => {
  const pages = new Map([["a.html", `<a href="archive/old.md">hist</a>`]]);
  const { errors, warnings } = checkInternalLinks(pages);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("archive/old.md"));
});

test("checkInternalLinks: external and site-absolute links are ignored", () => {
  const pages = new Map([
    ["a.html", `<a href="https://x.example">e</a><a href="/app">app</a><a href="mailto:a@b.c">m</a>`],
  ]);
  const { errors, warnings } = checkInternalLinks(pages);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});


/**
 * checkLandingAssets — added after the landing page shipped a 404 as its HERO
 * image for weeks (the People/Matches merge renamed the `11-matches` stem and
 * web/index.html was never repointed). Every case below except the first two is
 * a false positive this check actually produced while being written; each one
 * would have failed the deploy on a perfectly good landing page, which is worse
 * than the bug it catches.
 */
function landingFixture(html, files = []) {
  const root = mkdtempSync(join(tmpdir(), "landing-"));
  mkdirSync(join(root, "web", "assets", "screenshots"), { recursive: true });
  for (const f of files) writeFileSync(join(root, "web", f), "x");
  writeFileSync(join(root, "web", "index.html"), html);
  return root;
}

test("checkLandingAssets: a reference that resolves is not reported", () => {
  const root = landingFixture(
    '<img src="assets/screenshots/hero.png">',
    ["assets/screenshots/hero.png"],
  );
  assert.deepEqual(checkLandingAssets(root), []);
});

test("checkLandingAssets: a reference to a file that does not exist IS reported", () => {
  // The actual bug: index.html kept pointing at the pre-rename stem.
  const root = landingFixture('<img src="assets/screenshots/11-matches-light.png">');
  assert.deepEqual(checkLandingAssets(root), ["assets/screenshots/11-matches-light.png"]);
});

test("checkLandingAssets: data-i18n-href keys are not file references", () => {
  // `(?:src|href)=` matches the `-href` tail of `data-i18n-href` without a
  // lookbehind, which reported every i18n key on the page as a missing file.
  const root = landingFixture(
    '<a href="/docs/GUIDE.html" data-i18n-href="footer.organizer_guide_href">Guide</a>',
  );
  assert.deepEqual(checkLandingAssets(root), []);
});

test("checkLandingAssets: a data: URI containing commas and spaces stays one reference", () => {
  // The favicon is an inline SVG. Splitting src on commas the way srcset needs
  // tore it apart and reported the fragment `%3Csvg` as a missing file.
  const root = landingFixture(
    `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E">`,
  );
  assert.deepEqual(checkLandingAssets(root), []);
});

test("checkLandingAssets: srcset candidates are checked individually, descriptors stripped", () => {
  const root = landingFixture(
    '<source srcset="assets/screenshots/a.png 1x, assets/screenshots/b.png 2x">',
    ["assets/screenshots/a.png"],
  );
  assert.deepEqual(checkLandingAssets(root), ["assets/screenshots/b.png"]);
});

test("checkLandingAssets: absolute, protocol-relative and anchor links are left alone", () => {
  const root = landingFixture(
    '<a href="https://example.com/x.png">a</a><a href="//cdn/x.png">b</a>' +
      '<a href="#top">c</a><a href="/app">d</a>',
  );
  assert.deepEqual(checkLandingAssets(root), []);
});

test("checkLandingAssets: a query string or fragment does not make a real file look missing", () => {
  const root = landingFixture(
    '<img src="assets/screenshots/hero.png?v=2"><img src="assets/screenshots/hero.png#a">',
    ["assets/screenshots/hero.png"],
  );
  assert.deepEqual(checkLandingAssets(root), []);
});

/* ── Audit SB-105..SB-116 ─────────────────────────────────────────────────── */

test("langOf: the filename's language suffix, else English (SB-105)", () => {
  assert.equal(langOf("ORGANIZER-GUIDE-sk.md"), "sk");
  assert.equal(langOf("PARTICIPANT-GUIDE-es.md"), "es");
  assert.equal(langOf("ELEVATOR-PITCH-en.md"), "en");
  assert.equal(langOf("THREAT-MODEL.md"), "en");
});

test("alternatesOf: links every existing translation, nothing for a lone doc (SB-105)", () => {
  const files = ["G.md", "G-sk.md", "G-de.md", "P-en.md", "P-sk.md", "SPEC.md"];
  assert.deepEqual(alternatesOf("G-sk.md", files), [
    ["en", "G.html"],
    ["sk", "G-sk.html"],
    ["de", "G-de.html"],
  ]);
  assert.deepEqual(alternatesOf("P-sk.md", files), [
    ["en", "P-en.html"],
    ["sk", "P-sk.html"],
  ]);
  assert.deepEqual(alternatesOf("SPEC.md", files), []);
});

test("rewriteRepoLinks: ../ links to real repo files go to GitHub, typos stay (SB-106)", () => {
  const root = mkdtempSync(join(tmpdir(), "repo-"));
  mkdirSync(join(root, "packages", "c"), { recursive: true });
  writeFileSync(join(root, "packages", "c", "x.toml"), "");
  const out = rewriteRepoLinks(
    `<a href="../packages/c/x.toml">a</a><a href="../packages/c/nope.toml">b</a>`,
    root,
  );
  assert.ok(out.includes(`href="${REPO_BLOB}packages/c/x.toml"`));
  assert.ok(out.includes(`href="../packages/c/nope.toml"`));
});

test("checkInternalLinks: a relative non-page target must exist in the site (SB-106/SB-111)", () => {
  const pages = new Map([
    [
      "a.html",
      `<a href="../packages/c/x.toml">t</a><a href="images/ok.png">i</a><a href="../app/">app</a><a href="data:image/svg+xml,x">d</a>`,
    ],
  ]);
  const { errors } = checkInternalLinks(pages, { exists: (p) => p === "images/ok.png" });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("../packages/c/x.toml"));
});

test("cleanOutDir: removes stale pages and images, leaves other files (SB-110)", () => {
  const out = mkdtempSync(join(tmpdir(), "docs-out-"));
  mkdirSync(join(out, "images"));
  writeFileSync(join(out, "images", "old.png"), "x");
  writeFileSync(join(out, "DELETED-DOC.html"), "x");
  writeFileSync(join(out, "keep.txt"), "x");
  cleanOutDir(out);
  assert.equal(existsSync(join(out, "DELETED-DOC.html")), false);
  assert.equal(existsSync(join(out, "images")), false);
  assert.equal(existsSync(join(out, "keep.txt")), true);
});

test("THEME_JS: survives a localStorage that throws, and the toggle still works (SB-107)", () => {
  const attrs = {};
  let onReady;
  let onClick;
  const throwing = () => {
    throw new Error("SecurityError: The operation is insecure.");
  };
  const ctx = {
    localStorage: { getItem: throwing, setItem: throwing },
    matchMedia: () => ({ matches: false }),
    document: {
      documentElement: { setAttribute: (k, v) => (attrs[k] = v) },
      addEventListener: (_e, fn) => (onReady = fn),
      getElementById: () => ({ addEventListener: (_e, fn) => (onClick = fn) }),
    },
  };
  ctx.window = ctx;
  runInNewContext(THEME_JS, ctx);
  assert.equal(attrs["data-theme"], "dark");
  onReady();
  onClick();
  assert.equal(attrs["data-theme"], "light");
});

test("DOCS_CSP: allows exactly the theme script by hash (SB-114)", () => {
  const hash = createHash("sha256").update(THEME_JS).digest("base64");
  assert.ok(DOCS_CSP.includes(`script-src 'sha256-${hash}'`));
  assert.ok(!/script-src[^;]*unsafe-inline/.test(DOCS_CSP));
});
