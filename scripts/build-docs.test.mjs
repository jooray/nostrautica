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
import { resolveOutDir, checkInternalLinks } from "./build-docs.mjs";

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
