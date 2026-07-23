/**
 * Coordinator release provenance (§13.9). The daemon logs this at startup and
 * appends the release id to its kind-31611 announcement's `about` text, so a
 * running coordinator can be tied to a specific build without server access.
 *
 * Git is best-effort: a dev checkout resolves the real describe/SHA; a prod
 * host that runs from rsync'd source without `.git` falls back to the package
 * version. Set `NOSTRAUTICA_RELEASE_ID` in the service environment to pin the
 * id explicitly on such hosts (documented in docs/VERSIONING.md).
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { PROTOCOL_VERSION } from "@nostrautica/protocol";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export interface CoordinatorRelease {
  releaseId: string;
  gitSha: string;
  coordinatorVersion: string;
  wireProtocolVersion: number;
  buildTimestamp: string;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

let cached: CoordinatorRelease | undefined;

/** The coordinator's release manifest (computed once, then cached). */
export function coordinatorRelease(): CoordinatorRelease {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const describe = git(here, ["describe", "--tags", "--always", "--dirty"]);
  const sha = git(here, ["rev-parse", "HEAD"]);
  const commitIso = git(here, ["show", "-s", "--format=%cI", "HEAD"]);
  cached = {
    releaseId: process.env.NOSTRAUTICA_RELEASE_ID || describe || `v${pkg.version}`,
    gitSha: sha || "unknown",
    coordinatorVersion: pkg.version,
    wireProtocolVersion: PROTOCOL_VERSION,
    buildTimestamp: process.env.NOSTRAUTICA_BUILD_TIMESTAMP || commitIso || "unknown",
  };
  return cached;
}

/** The product release id alone (git describe/SHA, env override, or v<pkg>). */
export function releaseId(): string {
  return coordinatorRelease().releaseId;
}

/** One-line human summary for the startup log. */
export function releaseSummary(): string {
  const r = coordinatorRelease();
  return `nostrautica-coordinator ${r.releaseId} (pkg ${r.coordinatorVersion}, wire v${r.wireProtocolVersion}, ${r.gitSha.slice(0, 8)})`;
}
