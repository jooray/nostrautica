/**
 * Build-time release manifest (§13.9). Binds one deployed artifact to a single
 * product release: git identity, the three package versions, the wire protocol
 * version, BASE_PATH, and a build timestamp. The PWA embeds it (Settings →
 * About, and a startup console line) and derives the service-worker revision
 * from `releaseId` so the SAME commit builds a byte-reproducible revision and
 * every release changes it — replacing the old `Date.now()` revision that made
 * every rebuild look like a new release.
 *
 * Pure Node ESM (no deps) so it runs from vite.config.ts at build time. Git is
 * optional: a checkout without `.git` (e.g. rsync'd source) falls back to the
 * package version, and `NOSTRAUTICA_RELEASE_ID` overrides everything for a
 * deploy that wants to pin the id explicitly.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** @param {string} cwd @param {string[]} args @returns {string} */
function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/**
 * Best-effort git identity for a repo checkout at `cwd`.
 *
 * `--dirty` needs a WORK TREE. The production build runs inside the
 * `post-receive` hook on the build host, which exports `GIT_DIR` pointing at the
 * BARE repo — so `git describe --tags --always --dirty` there dies with "this
 * operation must be run in a work tree" and returns "" while `rev-parse HEAD`
 * happily succeeds. That asymmetry is what silently froze the PWA (see
 * `computeReleaseManifest`), so fall back to the work-tree-free form.
 *
 * @param {string} cwd
 */
export function gitInfo(cwd) {
  const sha = git(cwd, ["rev-parse", "HEAD"]);
  const describe =
    git(cwd, ["describe", "--tags", "--always", "--dirty"]) ||
    git(cwd, ["describe", "--tags", "--always"]);
  const commitIso = git(cwd, ["show", "-s", "--format=%cI", "HEAD"]);
  return { gitSha: sha || "unknown", describe, commitIso };
}

/** @param {string} repoRoot @param {string} rel @returns {string} */
function pkgVersion(repoRoot, rel) {
  try {
    return JSON.parse(readFileSync(join(repoRoot, rel), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Read PROTOCOL_VERSION (the wire version) straight from the protocol source. @param {string} repoRoot */
function wireProtocolVersion(repoRoot) {
  try {
    const src = readFileSync(join(repoRoot, "packages/protocol/src/schemas.ts"), "utf8");
    const m = src.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * @typedef {Object} ReleaseManifest
 * @property {string} releaseId       Product release id (git describe/SHA or v<pkg>). Human-facing.
 * @property {string} swRevision      Service-worker precache revision: unique per commit (see below).
 * @property {string} gitSha          Full commit SHA, or "unknown".
 * @property {string} appVersion
 * @property {string} protocolVersion  Protocol package version.
 * @property {string} coordinatorVersion  Coordinator package version.
 * @property {number} wireProtocolVersion  On-wire payload `v` (schemas.ts).
 * @property {string} basePath
 * @property {string} buildTimestamp  ISO-8601 (git commit time when available).
 */

/**
 * Compute the full release manifest for a repo checkout.
 * @param {{ repoRoot: string, basePath?: string }} opts
 * @returns {ReleaseManifest}
 */
export function computeReleaseManifest({ repoRoot, basePath = "" }) {
  const { gitSha, describe, commitIso } = gitInfo(repoRoot);
  const appVersion = pkgVersion(repoRoot, "packages/app/package.json");
  // The releaseId used to be the service-worker precache revision for the shell
  // index.html directly (it is now the prefix of `swRevision`, below). The old
  // chain fell straight from `describe` to `v<version>` — and because
  // `describe` returns "" under the deploy hook's bare GIT_DIR (see gitInfo),
  // production shipped `revision:"v0.7.0"` for every build. Nothing else in the
  // precache manifest varies per commit, so sw.js came out BYTE-IDENTICAL each
  // deploy, the browser's update check found no change, and the precached shell
  // stayed frozen at whatever build first published v0.7.0. Every navigation
  // then booted that ancient shell, whose content-hashed chunks `rsync --delete`
  // had long since removed → 404 → "route failed to load", unrecoverable except
  // by a hard reload (which bypasses the SW for one navigation only).
  // The gitSha rung makes the id vary per commit even with no tags and no work
  // tree; `v<version>` survives only as a truly last resort (no git at all).
  const releaseId =
    process.env.NOSTRAUTICA_RELEASE_ID ||
    describe ||
    (gitSha !== "unknown" ? gitSha.slice(0, 12) : "") ||
    `v${pkgVersion(repoRoot, "package.json")}`;
  return {
    releaseId,
    swRevision: serviceWorkerRevision(releaseId, gitSha),
    gitSha,
    appVersion,
    protocolVersion: pkgVersion(repoRoot, "packages/protocol/package.json"),
    coordinatorVersion: pkgVersion(repoRoot, "packages/coordinator/package.json"),
    wireProtocolVersion: wireProtocolVersion(repoRoot),
    basePath,
    buildTimestamp: process.env.NOSTRAUTICA_BUILD_TIMESTAMP || commitIso || new Date().toISOString(),
  };
}

/**
 * The service-worker precache revision for the shell `index.html`
 * (vite.config.ts). It is the ONLY per-commit input to `sw.js`, so it must differ
 * between any two commits, or the browser's update check sees a byte-identical
 * worker and the installed PWA never refreshes.
 *
 * `releaseId` alone is not enough (audit SB-52): on a commit that carries a tag,
 * `git describe` returns the bare tag name, so a re-cut release under the same
 * version (`git tag -f vX.Y.Z` onto a fixed commit) produced the same id, the same
 * `sw.js`, and a frozen shell whose hashed chunks `rsync --delete` had removed.
 * Appending the commit SHA makes it commit-unique while keeping the readable
 * release in front.
 *
 * With no git at all there is no commit identity to append, and `releaseId` is
 * then the constant `v<pkg>` (or a hand-set override) — the exact 2026-07-28
 * frozen-shell state (audit SB-59). Fall back to the build time: it loses
 * byte-reproducibility, which a build with no commit identity cannot have
 * anyway, and in exchange every such build still reaches installed clients.
 *
 * @param {string} releaseId @param {string} gitSha
 */
export function serviceWorkerRevision(releaseId, gitSha, now = Date.now) {
  if (gitSha === "unknown" || !gitSha) return `${releaseId}+build-${now()}`;
  const short = gitSha.slice(0, 12);
  return releaseId === short ? short : `${releaseId}+${short}`;
}
