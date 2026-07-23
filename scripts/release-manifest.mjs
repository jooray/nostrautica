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

/** Best-effort git identity for a repo checkout at `cwd`. @param {string} cwd */
export function gitInfo(cwd) {
  const sha = git(cwd, ["rev-parse", "HEAD"]);
  const describe = git(cwd, ["describe", "--tags", "--always", "--dirty"]);
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
 * @property {string} releaseId       Product release id (git describe/SHA or v<pkg>).
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
  const releaseId =
    process.env.NOSTRAUTICA_RELEASE_ID || describe || `v${pkgVersion(repoRoot, "package.json")}`;
  return {
    releaseId,
    gitSha,
    appVersion,
    protocolVersion: pkgVersion(repoRoot, "packages/protocol/package.json"),
    coordinatorVersion: pkgVersion(repoRoot, "packages/coordinator/package.json"),
    wireProtocolVersion: wireProtocolVersion(repoRoot),
    basePath,
    buildTimestamp: process.env.NOSTRAUTICA_BUILD_TIMESTAMP || commitIso || new Date().toISOString(),
  };
}
