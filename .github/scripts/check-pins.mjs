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
 *  3. Every `COPY` source in the coordinator Dockerfile is a COMMITTED path. The
 *     release gate builds from `git archive HEAD`, so a COPY of a path that is no
 *     longer tracked is a hard build error. That is how the gate went red for eight
 *     releases (audit SB-51): `packages/vendor/ts-mls` was retired on 2026-10-05
 *     and the Dockerfile kept copying it. This catches it in seconds, in the
 *     cheapest job, with the path named.
 *  4. Workflow toolchains are exact (audit R-80): no pnpm/action-setup `version:`
 *     other than the root `packageManager` pin, and every `deno-version:` an exact
 *     X.Y.Z.
 */
import { execFileSync } from "node:child_process";
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

// ── 3. Dockerfile COPY sources are committed ────────────────────────────────
// Only build-context COPYs (no --from=<stage>); the last operand is the
// destination. Checked against `git ls-files`, not the disk, because the gate's
// build context is `git archive HEAD`: an untracked leftover directory on a
// developer's machine must not make a stale COPY look fine.
for (const m of dockerfile.matchAll(/^COPY\s+(.+)$/gm)) {
  const args = m[1].trim().split(/\s+/);
  if (args.some((a) => a.startsWith("--from"))) continue;
  const operands = args.filter((a) => !a.startsWith("--"));
  for (const src of operands.slice(0, -1)) {
    let tracked = "";
    try {
      tracked = execFileSync("git", ["ls-files", "--", src], { cwd: repoRoot }).toString().trim();
    } catch (err) {
      errors.push(`could not run git ls-files for Dockerfile COPY source ${src}: ${err.message}`);
      continue;
    }
    if (!tracked) {
      errors.push(
        `docker/coordinator.Dockerfile COPYs ${src}, which is not a committed path (the clean-context build would fail)`,
      );
    }
  }
}

// ── 4. Toolchains in workflows are exact (audit R-80) ───────────────────────
// pnpm: package.json's `packageManager` is the pin (pnpm 11.12.0 was a broken
// release that once stalled a production deploy, so "any 11" is not a pin). A
// pnpm/action-setup `version:` overrides it, so one is allowed only when it is
// that exact version. Deno: `deno-version:` must be an exact X.Y.Z.
const packageManager = JSON.parse(read("package.json")).packageManager ?? "";
const pinnedPnpm = packageManager.match(/^pnpm@(\d+\.\d+\.\d+)/)?.[1];
if (!pinnedPnpm) errors.push(`root package.json: packageManager is not an exact pnpm@X.Y.Z (${packageManager})`);
for (const f of readdirSync(wfDir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
  const lines = readFileSync(join(wfDir, f), "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.includes("uses: pnpm/action-setup@")) {
      const indent = line.search(/\S/);
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (next.trim() === "") continue;
        if (next.search(/\S/) <= indent) break; // left the step
        const v = next.match(/^\s*version:\s*["']?([^"'\s#]+)/)?.[1];
        if (v !== undefined && v !== pinnedPnpm) {
          errors.push(
            `.github/workflows/${f}:${j + 1} pnpm/action-setup version ${v} overrides packageManager ${packageManager} — drop it or set ${pinnedPnpm}`,
          );
        }
      }
    }
    // A `deno run` resolves its dependency graph at run time unless a lockfile is
    // enforced (audit R-62), so every one must be --frozen.
    if (/^\s*deno run\b/.test(line) && !line.includes("--frozen")) {
      errors.push(`.github/workflows/${f}:${i + 1} deno run without --frozen (an unlocked dependency graph)`);
    }
    const deno = line.match(/^\s*deno-version:\s*["']?([^"'\s#]+)/)?.[1];
    if (deno !== undefined && !/^v?\d+\.\d+\.\d+$/.test(deno)) {
      errors.push(`.github/workflows/${f}:${i + 1} deno-version ${deno} is not an exact X.Y.Z release`);
    }
  });
}

// ── report ───────────────────────────────────────────────────────────────────
if (errors.length) {
  console.error("Pin guardrail FAILED (audit Q14):");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`Pin guardrail OK: Node major ${expectedMajor} everywhere; all infra images digest-pinned; every Dockerfile COPY source is committed; pnpm/Deno exact.`);
