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

/** The releaseId fallback when neither an env override nor git describe is available. */
function versionFallbackId(): string {
  return `v${pkg.version}`;
}

/** The coordinator's release manifest (computed once, then cached). */
export function coordinatorRelease(): CoordinatorRelease {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const describe = git(here, ["describe", "--tags", "--always", "--dirty"]);
  const sha = git(here, ["rev-parse", "HEAD"]);
  const commitIso = git(here, ["show", "-s", "--format=%cI", "HEAD"]);
  cached = {
    releaseId: process.env.NOSTRAUTICA_RELEASE_ID || describe || versionFallbackId(),
    // Honor an injected SHA BEFORE the git fallback (R23): a clean container/rsync
    // build ships no `.git`, so the daemon would otherwise always report
    // `gitSha: unknown`. The Dockerfile bakes NOSTRAUTICA_GIT_SHA from a build-arg.
    gitSha: process.env.NOSTRAUTICA_GIT_SHA || sha || "unknown",
    coordinatorVersion: pkg.version,
    wireProtocolVersion: PROTOCOL_VERSION,
    buildTimestamp: process.env.NOSTRAUTICA_BUILD_TIMESTAMP || commitIso || "unknown",
  };
  return cached;
}

/**
 * Whether a release manifest carries real build provenance (R23): a known git SHA,
 * OR an explicit releaseId (env override / git describe) rather than the bare
 * `v<pkg.version>` fallback. A clean build that injects either satisfies this.
 */
export function provenanceIsKnown(release: CoordinatorRelease = coordinatorRelease()): boolean {
  return release.gitSha !== "unknown" || release.releaseId !== versionFallbackId();
}

/**
 * Enforce that a production build knows its own provenance (R23). Throws when the
 * release manifest has no git SHA AND no explicit release id, unless `dev` — a
 * clean container/rsync build must inject NOSTRAUTICA_GIT_SHA or
 * NOSTRAUTICA_RELEASE_ID so a running daemon can be tied to a specific build. Pure
 * (takes the release + dev flag) so callers decide how strict to be; `main.ts`
 * treats the coordinator's `allow_insecure_urls` dev knob as `dev`.
 */
export function assertReleaseProvenance(
  release: CoordinatorRelease,
  opts: { dev: boolean },
): void {
  if (opts.dev) return;
  if (provenanceIsKnown(release)) return;
  throw new Error(
    "release provenance is unknown outside development: set NOSTRAUTICA_GIT_SHA " +
      "or NOSTRAUTICA_RELEASE_ID (clean container/rsync builds have no .git) — " +
      "a running coordinator must be tie-able to a specific build (§13.9, R23)",
  );
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
