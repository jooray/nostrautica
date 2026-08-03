/**
 * Readiness journey — pure derivation (redesign §4.1). Turns the attendee's real
 * state into an ordered stepper (Joined → Backup secured → Intro submitted →
 * Processing → Matches ready) with EXACTLY one primary CTA. Never persisted as a
 * second copy of state; the store (readiness.svelte.ts) gathers the inputs and
 * keeps a monotonic latch so a finished step never regresses to "checking" when
 * a later fetch fails offline.
 */
import {
  hasAiProfileContent,
  type AiProfile,
  type AttendeeProfile,
  type MediaDescriptor,
} from "@nostrautica/protocol";
import type { MessageKey } from "$lib/i18n/messages.js";
import type { Route } from "$lib/router/routes.js";

/**
 * Whether this attendee has given the coordinator anything at all to work with.
 *
 * The matcher refuses to score a profile with nothing in it (73cb3b8), so an
 * attendee in this state is silently absent from everyone's matches and from
 * their own — which is exactly what happened to roughly fifteen of one event's
 * fifty-three joiners. The journey used to describe them the same way it
 * describes someone mid-pipeline: "Processing — the coordinator is building
 * your profile." It is not, and it never will, because there is nothing to
 * build from.
 *
 * Deliberately generous about what counts. A bio, one skill, a stated interest,
 * a text intro, a recording, or an ai_profile the coordinator derived from
 * public Nostr activity — any of them and this person is matchable, so any of
 * them and we say nothing.
 */
export function hasAnythingToMatchOn(
  entry:
    | {
        profile?: AttendeeProfile;
        intro_text?: string;
        media?: MediaDescriptor[];
        ai_profile?: AiProfile;
      }
    | undefined,
): boolean {
  if (!entry) return false;
  const p = entry.profile;
  if (p && (p.about.trim() || p.skills.length > 0 || p.looking_for.trim())) return true;
  if (entry.intro_text?.trim()) return true;
  if ((entry.media ?? []).length > 0) return true;
  return hasAiProfileContent(entry.ai_profile);
}

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
  /**
   * "unknown" = the viewer's custody could not be READ (an IndexedDB error, or
   * an identity that hasn't finished arriving) — deliberately distinct from
   * "visitor", which is the positive claim "this identity holds nothing for this
   * event". Collapsing the two is what put "1 of 5 · Join this event" on an
   * organizer's own event: every owner-scoped read answers "no" while a NIP-46
   * session is still restoring, and that was rendered as a fact about the user.
   */
  role: "unknown" | "visitor" | "pending" | "attendee" | "organizer";
  signerMethod?: "local" | "nip07" | "nip46";
  backupAcked?: boolean; // undefined = the durable backup marker isn't known yet
  hasIntro?: boolean; // undefined = self-copy fetch failed / offline
  /**
   * The coordinator holds nothing matchable for this attendee (see
   * {@link hasAnythingToMatchOn}). Positive evidence only: `undefined` means we
   * have not read their published entry, never "probably fine".
   */
  profileEmpty?: boolean;
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
  profileEmpty?: boolean,
): { labelKey: MessageKey; route: Route } | undefined {
  switch (id) {
    case "joined":
      return { labelKey: "readiness.cta.join", route: { name: "join", naddr } };
    case "backup":
      return { labelKey: "readiness.cta.backup", route: { name: "me" } };
    case "intro":
      // With nothing on file at all, the cheap path is the one to offer. Sending
      // someone whose whole profile is blank to "Record your intro" asks them for
      // a camera, permission and a monologue when two typed sentences would fix
      // it — and it was the only action the journey ever surfaced.
      return profileEmpty
        ? { labelKey: "readiness.cta.profile", route: { name: "myProfile", naddr } }
        : { labelKey: "readiness.cta.record", route: { name: "record", naddr, talk: false } };
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
  } else if (input.role === "unknown") {
    // Custody unreadable: say so instead of guessing. "action-required" here is
    // an accusation ("you are not a member of this event") that costs the viewer
    // a wrong CTA and — before this — a persisted snapshot repeating it on every
    // later visit. "checking" makes no claim and carries no CTA.
    joined = {
      id: "joined",
      state: "checking",
      labelKey: LABEL.joined,
      hintKey: "readiness.hint.checking",
    };
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
  } else if (input.backupAcked === true) {
    backup = { id: "backup", state: "complete", labelKey: LABEL.backup };
  } else if (input.backupAcked === false) {
    backup = {
      id: "backup",
      state: "action-required",
      labelKey: LABEL.backup,
      hintKey: "readiness.hint.backup",
    };
  } else {
    // The durable (relay-persisted) backup marker hasn't been read yet — the
    // store paints from local state first and only then asks the relays. The
    // device-local "I saved it" dismissal is NOT a stand-in: treating it as one
    // is the dishonesty `key-backup.ts` exists to undo, and the monotonic latch
    // would make that one wrong "complete" permanent.
    backup = {
      id: "backup",
      state: "checking",
      labelKey: LABEL.backup,
      hintKey: "readiness.hint.checking",
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
      // "Optional, but you'll get much better matches" is true of someone who
      // wrote a bio and skipped the video. It is misleading for someone with
      // nothing at all, who is not getting worse matches — they are getting none.
      hintKey: input.profileEmpty === true ? "readiness.hint.empty" : "readiness.hint.intro",
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
  const primary = actionStep
    ? primaryFor(actionStep.id, input.naddr, input.profileEmpty)
    : undefined;

  const matchesReady = steps.some((s) => s.id === "matches" && s.state === "complete");

  return { steps, doneCount, currentIndex, allComplete, primary, matchesReady, viewerIsMember: isMember };
}
