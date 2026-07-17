#!/usr/bin/env node
/**
 * Runtime & infrastructure pinning guardrail (audit finding Q14).
 *
 * Fails CI when the declared Node runtime drifts apart across the repo, or when
 * container infrastructure is referenced by a mutable tag. Keeps README/docs out
 * of scope (they're prose, checked separately); this asserts the machine-read
 * declarations only.
 *
 * Checks:
 *  1. One Node MAJOR everywhere — root + per-package `engines.node`, the
 *     coordinator Dockerfile base image, and every workflow `node-version`.
 *  2. No mutable infrastructure tags — every `image:` in docker-compose must be
 *     pinned by an `@sha256:` digest (a bare `:latest` / `:master` / version tag
 *     is rejected).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const errors = [];

function read(p) {
  return readFileSync(join(repoRoot, p), "utf8");
}
function majorFromSemverRange(range) {
  const m = String(range).match(/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

// ── 1. Node major consistency ────────────────────────────────────────────────
const rootEngines = JSON.parse(read("package.json")).engines?.node;
const expectedMajor = majorFromSemverRange(rootEngines);
if (expectedMajor === undefined) {
  errors.push(`root package.json: could not read engines.node (${rootEngines})`);
}

const nodeMajors = []; // { where, major }
nodeMajors.push({ where: "root package.json engines", major: expectedMajor });

// Per-package engines (only those that declare one).
for (const pkg of readdirSync(join(repoRoot, "packages"))) {
  const pjPath = join("packages", pkg, "package.json");
  if (!existsSync(join(repoRoot, pjPath))) continue;
  const engines = JSON.parse(read(pjPath)).engines?.node;
  if (engines) {
    nodeMajors.push({ where: `${pjPath} engines`, major: majorFromSemverRange(engines) });
  }
}

// Coordinator Dockerfile base image.
const dockerfile = read("docker/coordinator.Dockerfile");
const fromMatch = dockerfile.match(/^FROM\s+node:(\d+)/m);
if (!fromMatch) {
  errors.push("docker/coordinator.Dockerfile: no `FROM node:<major>` found");
} else {
  nodeMajors.push({ where: "docker/coordinator.Dockerfile FROM", major: Number(fromMatch[1]) });
}

// Every workflow's node-version.
const wfDir = join(repoRoot, ".github", "workflows");
for (const f of readdirSync(wfDir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
  const yml = readFileSync(join(wfDir, f), "utf8");
  for (const m of yml.matchAll(/node-version:\s*["']?(\d+)/g)) {
    nodeMajors.push({ where: `.github/workflows/${f} node-version`, major: Number(m[1]) });
  }
}

for (const { where, major } of nodeMajors) {
  if (major !== expectedMajor) {
    errors.push(`Node major mismatch: ${where} = ${major}, expected ${expectedMajor}`);
  }
}

// ── 2. No mutable infrastructure tags ────────────────────────────────────────
const compose = read("docker/docker-compose.yml");
for (const m of compose.matchAll(/^\s*image:\s*(\S+)/gm)) {
  const ref = m[1];
  if (!ref.includes("@sha256:")) {
    errors.push(`docker-compose image not digest-pinned (mutable): ${ref}`);
  }
}

// ── report ───────────────────────────────────────────────────────────────────
if (errors.length) {
  console.error("Pin guardrail FAILED (audit Q14):");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`Pin guardrail OK: Node major ${expectedMajor} everywhere; all infra images digest-pinned.`);
