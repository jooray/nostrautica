import { describe, it, expect } from "vitest";
import { deriveReadiness, type ReadinessInput, type ReadinessStepId } from "./readiness.js";

function base(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    naddr: "naddr1xyz",
    role: "attendee",
    signerMethod: "local",
    backupAcked: true,
    hasIntro: true,
    processed: true,
    matchesAvailable: true,
    matchingEnabled: true,
    hasCoordinator: true,
    online: true,
    latched: new Set<ReadinessStepId>(),
    ...overrides,
  };
}

const stateOf = (r: ReturnType<typeof deriveReadiness>, id: ReadinessStepId) =>
  r.steps.find((s) => s.id === id)?.state;

describe("deriveReadiness", () => {
  it("fully ready member: 5 steps, all complete, no primary, matchesReady", () => {
    const r = deriveReadiness(base());
    expect(r.steps.map((s) => s.id)).toEqual(["joined", "backup", "intro", "processing", "matches"]);
    expect(r.allComplete).toBe(true);
    expect(r.currentIndex).toBe(-1);
    expect(r.doneCount).toBe(5);
    expect(r.primary).toBeUndefined();
    expect(r.matchesReady).toBe(true);
  });

  it("new attendee with no intro → intro action-required, primary = record", () => {
    const r = deriveReadiness(base({ hasIntro: false, processed: undefined, matchesAvailable: false }));
    expect(stateOf(r, "intro")).toBe("action-required");
    expect(stateOf(r, "processing")).toBe("checking");
    expect(stateOf(r, "matches")).toBe("waiting");
    expect(r.primary?.labelKey).toBe("readiness.cta.record");
    expect(r.primary?.route).toEqual({ name: "record", naddr: "naddr1xyz", talk: false });
  });

  it("processing and matches can complete without an intro — matching is not gated on it (2026-07-21)", () => {
    const r = deriveReadiness(base({ hasIntro: false, processed: true, matchesAvailable: true }));
    expect(stateOf(r, "intro")).toBe("action-required"); // still nudged, just not blocking
    expect(stateOf(r, "processing")).toBe("complete");
    expect(stateOf(r, "matches")).toBe("complete");
    expect(r.matchesReady).toBe(true);
  });

  it("visitor → joined action-required, primary = join (wins over later steps)", () => {
    const r = deriveReadiness(base({ role: "visitor", backupAcked: false, hasIntro: false }));
    expect(stateOf(r, "joined")).toBe("action-required");
    expect(r.primary?.labelKey).toBe("readiness.cta.join");
    expect(r.primary?.route).toEqual({ name: "join", naddr: "naddr1xyz" });
  });

  it("pending → joined in-progress with waiting hint", () => {
    const r = deriveReadiness(base({ role: "pending", hasIntro: false }));
    expect(stateOf(r, "joined")).toBe("in-progress");
    expect(r.steps[0].hintKey).toBe("readiness.hint.pending");
  });

  it("no coordinator → 3 steps only", () => {
    const r = deriveReadiness(base({ hasCoordinator: false }));
    expect(r.steps.map((s) => s.id)).toEqual(["joined", "backup", "intro"]);
  });

  it("matching disabled → 3 steps only", () => {
    const r = deriveReadiness(base({ matchingEnabled: false }));
    expect(r.steps.map((s) => s.id)).toEqual(["joined", "backup", "intro"]);
  });

  it("backup: local + not acked → action-required, primary = backup", () => {
    const r = deriveReadiness(base({ backupAcked: false }));
    expect(stateOf(r, "backup")).toBe("action-required");
    expect(r.primary?.labelKey).toBe("readiness.cta.backup");
    expect(r.primary?.route).toEqual({ name: "me" });
  });

  it("backup: signer holds the key (nip46) → complete with signerKey hint", () => {
    const r = deriveReadiness(base({ signerMethod: "nip46", backupAcked: false }));
    const backup = r.steps.find((s) => s.id === "backup")!;
    expect(backup.state).toBe("complete");
    expect(backup.hintKey).toBe("readiness.hint.signerKey");
  });

  it("offline/unknown intro → checking, NEVER a primary, no regression to a done step", () => {
    const r = deriveReadiness(base({ hasIntro: undefined, processed: undefined, matchesAvailable: undefined, online: false }));
    expect(stateOf(r, "intro")).toBe("checking");
    expect(stateOf(r, "joined")).toBe("complete");
    expect(stateOf(r, "backup")).toBe("complete");
    expect(r.primary).toBeUndefined();
  });

  it("monotonic latch forces a step complete despite unknown input", () => {
    const r = deriveReadiness(base({ hasIntro: undefined, latched: new Set<ReadinessStepId>(["intro"]) }));
    expect(stateOf(r, "intro")).toBe("complete");
    expect(r.steps.find((s) => s.id === "intro")!.hintKey).toBeUndefined();
  });

  it("processing in-progress when intro done but not yet processed", () => {
    const r = deriveReadiness(base({ processed: false, matchesAvailable: undefined }));
    expect(stateOf(r, "processing")).toBe("in-progress");
    expect(r.steps.find((s) => s.id === "processing")!.hintKey).toBe("readiness.hint.processing");
  });

  it("matches waiting when not available; matchesReady false", () => {
    const r = deriveReadiness(base({ matchesAvailable: false }));
    expect(stateOf(r, "matches")).toBe("waiting");
    expect(r.matchesReady).toBe(false);
  });

  it("exactly one primary CTA in every combination", () => {
    for (const role of ["visitor", "pending", "attendee", "organizer"] as const) {
      for (const backupAcked of [true, false]) {
        for (const hasIntro of [true, false, undefined]) {
          const r = deriveReadiness(base({ role, backupAcked, hasIntro }));
          const actionCount = r.steps.filter((s) => s.state === "action-required").length;
          // primary is defined iff there is at least one action-required step
          expect(!!r.primary).toBe(actionCount > 0);
        }
      }
    }
  });
});
