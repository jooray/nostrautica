import { describe, it, expect } from "vitest";
import {
  assertReleaseProvenance,
  provenanceIsKnown,
  type CoordinatorRelease,
} from "./release.js";
import pkg from "../package.json" with { type: "json" };

// The fallback release id is `v<package version>`, which carries no provenance.
// Derived, not hardcoded: a literal broke on the first coordinator version bump.
const BARE = `v${pkg.version}`;

function release(over: Partial<CoordinatorRelease>): CoordinatorRelease {
  return {
    releaseId: BARE,
    gitSha: "unknown",
    coordinatorVersion: pkg.version,
    wireProtocolVersion: 2,
    buildTimestamp: "unknown",
    ...over,
  };
}

describe("release provenance (audit R23)", () => {
  it("provenanceIsKnown: known git SHA OR explicit release id counts as provenance", () => {
    // Bare v<pkg> release id + unknown SHA = no provenance.
    expect(provenanceIsKnown(release({ releaseId: BARE, gitSha: "unknown" }))).toBe(false);
    // A real git SHA (injected via NOSTRAUTICA_GIT_SHA on a clean build) is enough.
    expect(provenanceIsKnown(release({ gitSha: "a".repeat(40) }))).toBe(true);
    // An explicit release id (git describe / NOSTRAUTICA_RELEASE_ID) is enough.
    expect(provenanceIsKnown(release({ releaseId: `${BARE}-3-gdeadbee` }))).toBe(true);
  });

  it("rejects unknown provenance OUTSIDE development", () => {
    const unknown = release({ releaseId: BARE, gitSha: "unknown" });
    // Production (dev:false) with no provenance → throws.
    expect(() => assertReleaseProvenance(unknown, { dev: false })).toThrow(/provenance is unknown/);
  });

  it("allows unknown provenance in development", () => {
    const unknown = release({ releaseId: BARE, gitSha: "unknown" });
    expect(() => assertReleaseProvenance(unknown, { dev: true })).not.toThrow();
  });

  it("passes in production when provenance is injected", () => {
    expect(() =>
      assertReleaseProvenance(release({ gitSha: "b".repeat(40) }), { dev: false }),
    ).not.toThrow();
    expect(() =>
      assertReleaseProvenance(release({ releaseId: "v0.2.0-5-gabcdef1" }), { dev: false }),
    ).not.toThrow();
  });
});
