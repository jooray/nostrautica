/**
 * The release manifest (§13.9) embedded at build by vite.config.ts via a
 * `define` for `__RELEASE_MANIFEST__`. Bound to one product release: git
 * identity, package/wire versions, BASE_PATH, and build time. Surfaced in
 * Settings → About and logged once at startup so a deployed bundle can be
 * identified without server access.
 *
 * The `declare` + fallback keeps typecheck (which has no `define`) and any code
 * path that runs before the define is applied honest instead of throwing.
 */
export interface ReleaseManifest {
  releaseId: string;
  gitSha: string;
  appVersion: string;
  protocolVersion: string;
  coordinatorVersion: string;
  wireProtocolVersion: number;
  basePath: string;
  buildTimestamp: string;
}

declare const __RELEASE_MANIFEST__: ReleaseManifest | undefined;

const FALLBACK: ReleaseManifest = {
  releaseId: "dev",
  gitSha: "unknown",
  appVersion: "0.0.0",
  protocolVersion: "0.0.0",
  coordinatorVersion: "0.0.0",
  wireProtocolVersion: 0,
  basePath: "",
  buildTimestamp: "unknown",
};

export const RELEASE_MANIFEST: ReleaseManifest =
  typeof __RELEASE_MANIFEST__ !== "undefined" ? __RELEASE_MANIFEST__ : FALLBACK;

/** One-line human summary for logs/support. */
export function releaseSummary(m: ReleaseManifest = RELEASE_MANIFEST): string {
  return `nostrautica ${m.releaseId} (app ${m.appVersion}, protocol ${m.protocolVersion}, wire v${m.wireProtocolVersion}, ${m.gitSha.slice(0, 8)})`;
}
