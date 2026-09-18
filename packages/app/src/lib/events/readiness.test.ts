import { describe, it, expect } from "vitest";
import {
  deriveReadiness,
  hasAnythingToMatchOn,
  type ReadinessInput,
  type ReadinessStepId,
} from "./readiness.js";

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

  it("role 'unknown' → joined is CHECKING, not an accusation, and carries no CTA", () => {
    // The custody read itself failed (or an identity hasn't finished arriving).
    // "action-required" here reads as "you are not a member of this event" and
    // hands an organizer a Join button for the event they own — the 2026-07-24
    // report. Say nothing instead.
    const r = deriveReadiness(base({ role: "unknown", hasIntro: undefined, processed: undefined, matchesAvailable: undefined }));
    expect(stateOf(r, "joined")).toBe("checking");
    expect(r.steps[0].hintKey).toBe("readiness.hint.checking");
    expect(r.primary).toBeUndefined();
    expect(r.viewerIsMember).toBe(false);
    expect(r.doneCount).toBe(1); // only "backup" (the signer holds the key)
  });

  it("role 'unknown' still honours the latch — a step that WAS complete stays complete", () => {
    const r = deriveReadiness(base({ role: "unknown", latched: new Set<ReadinessStepId>(["joined"]) }));
    expect(stateOf(r, "joined")).toBe("complete");
  });

  it("backupAcked undefined → backup is CHECKING, never a false 'secured'", () => {
    // The local phase paints before the durable relay marker is read. Completing
    // the step on the device-local dismiss-nag would latch that lie permanently.
    const r = deriveReadiness(base({ signerMethod: "local", backupAcked: undefined }));
    expect(stateOf(r, "backup")).toBe("checking");
    expect(r.steps.find((s) => s.id === "backup")!.hintKey).toBe("readiness.hint.checking");
    expect(r.primary).toBeUndefined(); // checking is never an action
  });

  it("UX-O4: viewerIsMember is true only for approved members, gating 'See who's here'", () => {
    expect(deriveReadiness(base({ role: "visitor" })).viewerIsMember).toBe(false);
    expect(deriveReadiness(base({ role: "pending" })).viewerIsMember).toBe(false);
    expect(deriveReadiness(base({ role: "attendee" })).viewerIsMember).toBe(true);
    expect(deriveReadiness(base({ role: "organizer" })).viewerIsMember).toBe(true);
  });

  it("UX-O4: a pending viewer is never pushed to backup/intro — approval is the blocker", () => {
    // Pending + not backed up + no intro: the ONLY primary CTA is the joined step
    // (waiting on approval), never backup or record.
    const r = deriveReadiness(base({ role: "pending", backupAcked: false, hasIntro: false }));
    expect(stateOf(r, "joined")).toBe("in-progress");
    // No action-required primary is offered while approval is pending.
    expect(r.primary).toBeUndefined();
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

  it("at most one primary CTA, and it is role-appropriate in every combination", () => {
    for (const role of ["visitor", "pending", "attendee", "organizer"] as const) {
      for (const backupAcked of [true, false]) {
        for (const hasIntro of [true, false, undefined]) {
          const r = deriveReadiness(base({ role, backupAcked, hasIntro }));
          const isMember = role === "attendee" || role === "organizer";
          const joinedAction = r.steps.find((s) => s.id === "joined")?.state === "action-required";
          const anyAction = r.steps.some((s) => s.state === "action-required");
          // Members get the first action-required step; non-members only ever get
          // the "joined" step (UX-O4) — never backup/intro while joining is the
          // blocker.
          const expected = isMember ? anyAction : joinedAction;
          expect(!!r.primary).toBe(expected);
          if (r.primary && !isMember) {
            expect(r.primary.labelKey).toBe("readiness.cta.join");
          }
        }
      }
    }
  });
});

/**
 * An attendee the matcher will refuse to score (73cb3b8) is not "mid-pipeline",
 * and the journey must not describe them as if they were. Fifteen of one
 * event's fifty-three joiners sat in this state, told the coordinator was
 * building their profile, which it never would be.
 */
describe("hasAnythingToMatchOn", () => {
  const blank = { about: "", skills: [], looking_for: "", links: [] };

  it("is false for a joined-but-silent attendee", () => {
    expect(hasAnythingToMatchOn({ profile: blank })).toBe(false);
    expect(hasAnythingToMatchOn(undefined)).toBe(false);
  });

  it("accepts any one of bio, a skill, or a stated interest", () => {
    expect(hasAnythingToMatchOn({ profile: { ...blank, about: "I build meshes" } })).toBe(true);
    expect(hasAnythingToMatchOn({ profile: { ...blank, skills: ["rust"] } })).toBe(true);
    expect(hasAnythingToMatchOn({ profile: { ...blank, looking_for: "a co-founder" } })).toBe(true);
  });

  it("accepts a text intro or a recording with no authored fields", () => {
    expect(hasAnythingToMatchOn({ profile: blank, intro_text: "hello" })).toBe(true);
    expect(
      hasAnythingToMatchOn({ profile: blank, media: [{ kind: "intro" } as never] }),
    ).toBe(true);
  });

  it("accepts an ai_profile the coordinator derived from public Nostr activity", () => {
    expect(
      hasAnythingToMatchOn({
        profile: blank,
        ai_profile: { summary: "builds mesh networks", skills: [], interests: [], offers: [], seeks: [] },
      }),
    ).toBe(true);
    // The hollow shell the pipeline publishes for someone with no input is NOT content.
    expect(
      hasAnythingToMatchOn({
        profile: blank,
        ai_profile: { summary: "", skills: [], interests: [], offers: [], seeks: [] },
      }),
    ).toBe(false);
  });
});

describe("deriveReadiness — an empty profile is its own problem", () => {
  it("points at the profile editor, not at recording a video", () => {
    // "Record your intro" asks for a camera and a monologue; two typed sentences
    // would fix this. It was the only action the journey ever offered.
    const r = deriveReadiness(base({ hasIntro: false, profileEmpty: true, latched: new Set() }));
    expect(r.primary?.route).toEqual({ name: "myProfile", naddr: "naddr1xyz" });
    expect(r.primary?.labelKey).toBe("readiness.cta.profile");
    expect(r.steps.find((s) => s.id === "intro")?.hintKey).toBe("readiness.hint.empty");
  });

  it("keeps the ordinary intro nudge for someone who wrote something", () => {
    const r = deriveReadiness(base({ hasIntro: false, profileEmpty: false, latched: new Set() }));
    expect(r.primary?.route).toEqual({ name: "record", naddr: "naddr1xyz", talk: false });
    expect(r.steps.find((s) => s.id === "intro")?.hintKey).toBe("readiness.hint.intro");
  });

  it("says nothing when we have not read their entry (positive evidence only)", () => {
    const r = deriveReadiness(base({ hasIntro: false, profileEmpty: undefined, latched: new Set() }));
    expect(r.steps.find((s) => s.id === "intro")?.hintKey).toBe("readiness.hint.intro");
  });
});

describe("processing failure (LEAD-1: the journey could not say \"failed\")", () => {
  // Before this, `deriveReadiness` declared a "failed" state and never emitted it:
  // a poisoned process_attendee leaves a directory entry with no ai_profile, which
  // reads as `processed: false`, which rendered "Processing — the coordinator is
  // building your profile" forever, with no CTA, next to a banner saying it had
  // failed.
  it("media failure → processing failed, hint + CTA point at re-recording", () => {
    const r = deriveReadiness(
      base({
        processed: false,
        matchesAvailable: false,
        processingFailed: { stage: "process_attendee", errorCategory: "media_processing", retryable: true },
      }),
    );
    expect(stateOf(r, "processing")).toBe("failed");
    expect(r.steps.find((s) => s.id === "processing")?.hintKey).toBe("readiness.hint.failedMedia");
    expect(r.primary?.labelKey).toBe("readiness.cta.rerecord");
    expect(r.primary?.route).toEqual({ name: "record", naddr: "naddr1xyz", talk: false });
  });

  it("non-media failure → processing failed, CTA points at the profile editor", () => {
    for (const errorCategory of ["provider_contract", "processing_error", "internal", undefined]) {
      const r = deriveReadiness(
        base({
          processed: false,
          matchesAvailable: false,
          processingFailed: { stage: "process_attendee", errorCategory },
        }),
      );
      expect(stateOf(r, "processing")).toBe("failed");
      expect(r.steps.find((s) => s.id === "processing")?.hintKey).toBe("readiness.hint.failed");
      expect(r.primary?.labelKey).toBe("readiness.cta.editProfile");
      expect(r.primary?.route).toEqual({ name: "myProfile", naddr: "naddr1xyz" });
    }
  });

  it("a failed step outranks an optional intro nudge for the single primary CTA", () => {
    const r = deriveReadiness(
      base({
        hasIntro: false, // "intro" is action-required and sits EARLIER in the list
        processed: false,
        matchesAvailable: false,
        processingFailed: { stage: "process_attendee", errorCategory: "media_fetch" },
      }),
    );
    expect(stateOf(r, "intro")).toBe("action-required");
    expect(r.primary?.labelKey).toBe("readiness.cta.rerecord");
  });

  it("a confirmed ai_profile still wins: a later failure never un-builds a built profile", () => {
    const r = deriveReadiness(
      base({ processed: true, processingFailed: { stage: "process_attendee", errorCategory: "media_fetch" } }),
    );
    expect(stateOf(r, "processing")).toBe("complete");
  });

  it("the monotonic latch still beats a failure notice we cannot corroborate", () => {
    // `processed: undefined` = the directory entry could not be READ (offline, a
    // rotated ECK, a relay gap). The failure notice is a cached 21606 that may
    // predate a retry which fixed it, so with nothing to corroborate it the latch
    // wins — which is the whole reason the latch exists. Telling someone whose
    // profile is fine that it failed, because they happened to open the app on a
    // train, is the failure mode being avoided here.
    const r = deriveReadiness(
      base({
        processed: undefined,
        matchesAvailable: false,
        latched: new Set<ReadinessStepId>(["processing"]),
        processingFailed: { stage: "process_attendee", errorCategory: "media_fetch" },
      }),
    );
    expect(stateOf(r, "processing")).toBe("complete");
  });

  /**
   * Audit A-2. `processed: false` is NOT an absence of evidence — the entry was
   * read and carries no ai_profile, so nothing is built, the attendee is absent
   * from everyone's matches, and the coordinator has sealed them a 21606 saying
   * why. The latch used to paper over exactly that, so the journey widget said
   * "5 of 5 complete" with no CTA while the banner at the top of the same screen
   * said processing had failed. This is the shape a re-submission that poisons
   * after a successful first pass produces.
   */
  it("a latched step still reports FAILED when the entry proves nothing is built", () => {
    const r = deriveReadiness(
      base({
        processed: false,
        matchesAvailable: false,
        latched: new Set<ReadinessStepId>(["joined", "backup", "intro", "processing", "matches"]),
        processingFailed: { stage: "process_attendee", errorCategory: "provider_contract" },
      }),
    );
    expect(stateOf(r, "processing")).toBe("failed");
    expect(r.allComplete).toBe(false);
    // And the widget names the next step instead of naming nothing.
    expect(r.primary?.labelKey).toBe("readiness.cta.editProfile");
  });

  it("a non-member is never offered the processing CTA", () => {
    const r = deriveReadiness(
      base({
        role: "pending",
        processed: false,
        matchesAvailable: false,
        processingFailed: { stage: "process_attendee", errorCategory: "media_fetch" },
      }),
    );
    expect(r.primary).toBeUndefined();
  });
});
