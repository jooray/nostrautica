/**
 * Readiness journey — pure derivation (redesign §4.1). Turns the attendee's real
 * state into an ordered stepper (Joined → Backup secured → Intro submitted →
 * Processing → Matches ready) with EXACTLY one primary CTA. Never persisted as a
 * second copy of state; the store (readiness.svelte.ts) gathers the inputs and
 * keeps a monotonic latch so a finished step never regresses to "checking" when
 * a later fetch fails offline.
 */
import type { MessageKey } from "$lib/i18n/messages.js";
import type { Route } from "$lib/router/routes.js";

export type ReadinessStepId = "joined" | "backup" | "intro" | "processing" | "matches";
export type ReadinessStepState =
  | "complete"
  | "action-required"
  | "in-progress"
  | "waiting"
  | "failed"
  | "checking";

export interface ReadinessInput {
  naddr: string;
  role: "visitor" | "pending" | "attendee" | "organizer";
  signerMethod?: "local" | "nip07" | "nip46";
  backupAcked: boolean;
  hasIntro?: boolean; // undefined = self-copy fetch failed / offline
  processed?: boolean; // undefined = unknown
  matchesAvailable?: boolean; // undefined = unknown
  matchingEnabled: boolean;
  hasCoordinator: boolean;
  online: boolean;
  latched: Set<ReadinessStepId>; // monotonic per-coordinate memory (from the store)
}

export interface ReadinessStep {
  id: ReadinessStepId;
  state: ReadinessStepState;
  labelKey: MessageKey;
  hintKey?: MessageKey; // shown for the current step only
}

export interface Readiness {
  steps: ReadinessStep[]; // 3 steps when matching off / no coordinator, else 5
  doneCount: number;
  currentIndex: number; // first non-complete step; -1 when all complete
  allComplete: boolean;
  primary?: { labelKey: MessageKey; route: Route }; // exactly one, or none when complete
  /** True when a matches list exists — the UI offers a secondary "See your matches". */
  matchesReady: boolean;
  /**
   * True only when the viewer is an approved member (attendee/organizer) — People
   * is member-gated, so "See who's here" must not be offered otherwise (UX-O4).
   */
  viewerIsMember: boolean;
}

const LABEL: Record<ReadinessStepId, MessageKey> = {
  joined: "readiness.step.joined",
  backup: "readiness.step.backup",
  intro: "readiness.step.intro",
  processing: "readiness.step.processing",
  matches: "readiness.step.matches",
};

function primaryFor(
  id: ReadinessStepId,
  naddr: string,
): { labelKey: MessageKey; route: Route } | undefined {
  switch (id) {
    case "joined":
      return { labelKey: "readiness.cta.join", route: { name: "join", naddr } };
    case "backup":
      return { labelKey: "readiness.cta.backup", route: { name: "me" } };
    case "intro":
      return { labelKey: "readiness.cta.record", route: { name: "record", naddr, talk: false } };
    default:
      return undefined;
  }
}

export function deriveReadiness(input: ReadinessInput): Readiness {
  const isMember = input.role === "attendee" || input.role === "organizer";
  // 5 steps only when matching can actually happen; never show an impossible step.
  const fiveSteps = input.hasCoordinator && input.matchingEnabled;

  const steps: ReadinessStep[] = [];

  // --- joined ---
  let joined: ReadinessStep;
  if (isMember) {
    joined = { id: "joined", state: "complete", labelKey: LABEL.joined };
  } else if (input.role === "pending") {
    joined = {
      id: "joined",
      state: "in-progress",
      labelKey: LABEL.joined,
      hintKey: "readiness.hint.pending",
    };
  } else {
    joined = { id: "joined", state: "action-required", labelKey: LABEL.joined };
  }
  steps.push(joined);

  // --- backup ---
  const signerHoldsKey = input.signerMethod === "nip07" || input.signerMethod === "nip46";
  let backup: ReadinessStep;
  if (signerHoldsKey) {
    backup = {
      id: "backup",
      state: "complete",
      labelKey: LABEL.backup,
      hintKey: "readiness.hint.signerKey",
    };
  } else if (input.backupAcked) {
    backup = { id: "backup", state: "complete", labelKey: LABEL.backup };
  } else {
    backup = {
      id: "backup",
      state: "action-required",
      labelKey: LABEL.backup,
      hintKey: "readiness.hint.backup",
    };
  }
  steps.push(backup);

  // --- intro ---
  let intro: ReadinessStep;
  if (input.hasIntro === true) {
    intro = { id: "intro", state: "complete", labelKey: LABEL.intro };
  } else if (input.hasIntro === false) {
    intro = {
      id: "intro",
      state: "action-required",
      labelKey: LABEL.intro,
      hintKey: "readiness.hint.intro",
    };
  } else {
    intro = {
      id: "intro",
      state: "checking",
      labelKey: LABEL.intro,
      hintKey: "readiness.hint.checking",
    };
  }
  steps.push(intro);

  if (fiveSteps) {
    // --- processing ---
    // Not gated on intro: the coordinator starts matching at approval time from
    // the authored profile + public Nostr activity, no intro required (user
    // feedback 2026-07-21). An intro just makes the resulting matches better —
    // see the "intro" step's own nudge hint above.
    let processing: ReadinessStep;
    if (input.processed === true) {
      processing = { id: "processing", state: "complete", labelKey: LABEL.processing };
    } else if (input.processed === false) {
      processing = {
        id: "processing",
        state: "in-progress",
        labelKey: LABEL.processing,
        hintKey: "readiness.hint.processing",
      };
    } else {
      processing = {
        id: "processing",
        state: "checking",
        labelKey: LABEL.processing,
        hintKey: "readiness.hint.checking",
      };
    }
    steps.push(processing);

    // --- matches ---
    let matches: ReadinessStep;
    if (input.matchesAvailable === true) {
      matches = { id: "matches", state: "complete", labelKey: LABEL.matches };
    } else if (input.matchesAvailable === undefined) {
      matches = {
        id: "matches",
        state: "checking",
        labelKey: LABEL.matches,
        hintKey: "readiness.hint.checking",
      };
    } else {
      matches = { id: "matches", state: "waiting", labelKey: LABEL.matches };
    }
    steps.push(matches);
  }

  // Monotonic latch: any step that was ever complete stays complete.
  for (const s of steps) {
    if (input.latched.has(s.id)) {
      s.state = "complete";
      s.hintKey = undefined;
    }
  }

  const doneCount = steps.filter((s) => s.state === "complete").length;
  const currentIndex = steps.findIndex((s) => s.state !== "complete");
  const allComplete = currentIndex === -1;

  // Exactly one primary CTA: the first action-required step (never waiting /
  // in-progress / checking). Role-derived (UX-O4): a non-member's only actionable
  // step is "joined" — a pending/visitor user must never be pushed to back up or
  // record an intro when the actual blocker is joining/approval. Backup + intro
  // become primaries only once the viewer is a member.
  const actionStep = isMember
    ? steps.find((s) => s.state === "action-required")
    : steps.find((s) => s.id === "joined" && s.state === "action-required");
  const primary = actionStep ? primaryFor(actionStep.id, input.naddr) : undefined;

  const matchesReady = steps.some((s) => s.id === "matches" && s.state === "complete");

  return { steps, doneCount, currentIndex, allComplete, primary, matchesReady, viewerIsMember: isMember };
}
