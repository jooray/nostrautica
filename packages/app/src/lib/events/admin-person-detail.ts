/**
 * Assemble a per-person operational dossier for the admin People drawer
 * (Phase 5A carry-over a). Pure: it derives provenance + an operational timeline
 * purely from data the Admin page already holds — the roster/review membership
 * state, the coordinator's attendee-scoped status events, and the person's talk
 * submissions — so the drawer needs no new fetch and this logic is unit-testable.
 * The component localizes the returned keys.
 */
import type { AttendeeProfile, MediaDescriptor, CoordinatorStatusContent } from "@nostrautica/protocol";

export type Membership = "approved" | "revoked" | "pending" | "rejected" | "deferred";
export type IntroKind = "video" | "audio" | "text" | "none";

export interface PersonProvenance {
  role: "attendee" | "organizer";
  membership: Membership;
  /** Whether we have this person's submitted intake (profile/media/text) at all. */
  intakeAvailable: boolean;
  introKind: IntroKind;
}

export interface TimelineEntry {
  kind: "status" | "talk";
  /** i18n key for the event label. */
  labelKey: string;
  tone: "ok" | "warn" | "neutral";
  /** Unix seconds, when known — the drawer sorts newest first. */
  at?: number;
  /** Extra raw detail (talk title, sanitized error category) — not localized. */
  detail?: string;
}

export interface PersonDetailInput {
  role: "attendee" | "organizer";
  revoked: boolean;
  inRoster: boolean;
  intakeAvailable: boolean;
  pending: boolean;
  reviewState?: "rejected" | "deferred";
  profile?: AttendeeProfile;
  media?: MediaDescriptor[];
  introText?: string;
  /** Coordinator status events (already restricted to this person's pubkey). */
  statuses: CoordinatorStatusContent[];
  /** This person's talk submissions: title + moderation status. */
  talks: { title: string; status: "pending" | "published" | "rejected"; at?: number }[];
}

/** Which intro medium the person supplied, if any. */
export function introKindOf(input: {
  media?: MediaDescriptor[];
  introText?: string;
}): IntroKind {
  const intro = input.media?.find((m) => m.kind === "intro");
  if (intro) return intro.m.startsWith("audio/") ? "audio" : "video";
  if (input.introText && input.introText.trim()) return "text";
  return "none";
}

/** Resolve the person's membership state for the provenance header. */
export function membershipOf(input: PersonDetailInput): Membership {
  if (input.revoked) return "revoked";
  if (input.reviewState === "rejected") return "rejected";
  if (input.reviewState === "deferred") return "deferred";
  if (input.inRoster) return "approved";
  return input.pending ? "pending" : "approved";
}

const STATUS_LABELS: Record<string, string> = {
  poison: "admin.person.event.failed",
  cleared: "admin.person.event.recovered",
};

const TALK_LABELS: Record<string, string> = {
  pending: "admin.person.talk.pending",
  published: "admin.person.talk.published",
  rejected: "admin.person.talk.rejected",
};

/** Build the provenance summary + newest-first operational timeline. */
export function buildPersonDetail(input: PersonDetailInput): {
  provenance: PersonProvenance;
  timeline: TimelineEntry[];
} {
  const provenance: PersonProvenance = {
    role: input.role,
    membership: membershipOf(input),
    intakeAvailable: input.intakeAvailable,
    introKind: introKindOf(input),
  };

  const timeline: TimelineEntry[] = [];

  for (const s of input.statuses) {
    const key = s.state ? STATUS_LABELS[s.state] : undefined;
    if (!key) continue;
    timeline.push({
      kind: "status",
      labelKey: key,
      tone: s.state === "poison" ? "warn" : "ok",
      at: s.at,
      detail: s.stage ?? s.error_category,
    });
  }

  for (const tk of input.talks) {
    timeline.push({
      kind: "talk",
      labelKey: TALK_LABELS[tk.status] ?? "admin.person.talk.pending",
      tone: tk.status === "rejected" ? "warn" : tk.status === "published" ? "ok" : "neutral",
      at: tk.at,
      detail: tk.title,
    });
  }

  // Newest first; entries without a timestamp sink to the bottom in stable order.
  timeline.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  return { provenance, timeline };
}
