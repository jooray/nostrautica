/**
 * Admin People / join-queue derivation — pure logic (audit UX-A1, UX-A2, UX-A4).
 *
 * These functions carry the correctness contract the admin screen used to get
 * wrong, extracted so they're unit-testable independently of the Svelte view:
 *
 *  - UX-A1: the durable ECK roster is the source of truth for who is approved.
 *    `buildApprovedPeople` enumerates people FROM the roster (plus anyone approved
 *    or revoked this session), then enriches each with the recent gift-wrap intake
 *    and directory entry where available. A roster member whose intake details
 *    aren't fetchable is still listed — with `intakeAvailable: false` — so their
 *    revoke/reprocess controls never disappear just because their join request
 *    aged out of the backfill window.
 *
 *  - UX-A2: `mergePending` folds a (possibly partial) relay refresh INTO the
 *    durable known queue instead of replacing it. A request already known is never
 *    dropped because a bounded relay scan happened to omit it; it leaves the
 *    pending VIEW only on a confirmed transition (approved in the roster, or
 *    revoked), which the view filter — not this merge — expresses.
 *
 *  - UX-A4: `summarizeBulk` reports per-item bulk-approval outcomes as a final
 *    "N approved, M need retry" tally.
 */
import type {
  AttendeeProfile,
  MediaDescriptor,
  RosterContent,
  DirectoryEntryContent,
  CoordinatorStatusContent,
} from "@nostrautica/protocol";
import type { PendingRequest } from "./organizer.js";

/**
 * Merge a fresh (possibly partial) pending fetch into the durable known queue
 * (UX-A2). Union by attendee pubkey; when both sides have an attendee, the newer
 * rumor (by `rumorCreatedAt`, fresh winning ties so updated intake flows in) wins.
 * A known attendee absent from `fresh` is RETAINED — a bounded relay scan omitting
 * it is not evidence they withdrew. Sorted oldest-first, matching `fetchPending`.
 */
export function mergePending(
  known: PendingRequest[],
  fresh: PendingRequest[],
): PendingRequest[] {
  const byPubkey = new Map<string, PendingRequest>();
  for (const req of known) byPubkey.set(req.attendeePubkey, req);
  for (const req of fresh) {
    const prev = byPubkey.get(req.attendeePubkey);
    // Fresh wins on newer OR equal timestamp: a re-fetch of the same request
    // carries the latest folded-in submission (profile/media/intro), so prefer it.
    if (!prev || req.rumorCreatedAt >= prev.rumorCreatedAt) {
      byPubkey.set(req.attendeePubkey, req);
    }
  }
  return [...byPubkey.values()].sort((a, b) => a.rumorCreatedAt - b.rumorCreatedAt);
}

/**
 * The pending QUEUE view: known requests minus anyone who has made a confirmed
 * transition out of pending (approved — in the roster or just now — or revoked)
 * or been locally rejected (UX-A7, no protocol action). Removal happens HERE,
 * never in `mergePending`.
 *
 * `revokedAt` is the persisted per-event revocation time (R-13): a request no
 * newer than the person's revocation is the one they were revoked over, not a
 * new ask, and must not come back as approvable after a reload.
 */
export function visiblePending(
  known: PendingRequest[],
  isApproved: (pubkey: string) => boolean,
  revoked: Set<string>,
  rejected: Set<string> = new Set(),
  revokedAt: Readonly<Record<string, number>> = {},
): PendingRequest[] {
  return known.filter((r) => {
    const at = revokedAt[r.attendeePubkey];
    return (
      !isApproved(r.attendeePubkey) &&
      !revoked.has(r.attendeePubkey) &&
      !rejected.has(r.attendeePubkey) &&
      !(at !== undefined && r.rumorCreatedAt <= at)
    );
  });
}

/** Operational state of an approved person, derived from 21606 statuses. */
export type PersonOpState = "ok" | "processing" | "failed";

/**
 * One approved person's group-chat status, for the organizer (audit U-3).
 *
 * - `in-room`: one of their devices holds a leaf in this event's MLS group. Only
 *   knowable when THIS browser's chat session holds the room (the organizer's own
 *   device is a member) — `memberDevices` is that session's group roster.
 * - `waiting`: they have a device attested (roster `chat_keys`) but it is not in
 *   the room this session can see.
 * - `attested`: a device is attested and membership cannot be seen from here (no
 *   live chat session for this event in this browser).
 * - `not-yet`: no chat device at all; they have not opened the chat.
 * - `stuck`: the coordinator gave up adding them (21606 poison, stage
 *   `chat_sync_member`). Retrying is a coordinator-side action.
 * - `refused`: the coordinator refused their device (21606 poison, stage
 *   `chat_attestation`) — only if the coordinator also seals that to E_id; today
 *   it seals it to the attendee, so organizers rarely see it.
 */
export type ChatAttendeeStatus = "in-room" | "waiting" | "attested" | "not-yet" | "stuck" | "refused";

/** 21606 stages that are about one attendee's chat membership. */
export const CHAT_SYNC_STAGE = "chat_sync_member";
export const CHAT_ATTESTATION_STAGE = "chat_attestation";

/**
 * Attendees the coordinator currently could not add to the chat (audit R-3/U-3):
 * the latest 21606 for stage `chat_sync_member` and that pubkey is a poison
 * (coordinator error_category `chat_sync_incomplete`). A later `cleared` for the
 * same stage and pubkey resolves it. Distinct pubkeys, input order.
 */
export function chatSyncStuckPubkeys(statuses: CoordinatorStatusContent[] | undefined): string[] {
  const latest = new Map<string, CoordinatorStatusContent>();
  for (const s of statuses ?? []) {
    if (s.stage !== CHAT_SYNC_STAGE || !s.pubkey) continue;
    if (s.state !== "poison" && s.state !== "cleared") continue;
    const prev = latest.get(s.pubkey);
    if (!prev || s.at > prev.at) latest.set(s.pubkey, s);
  }
  return [...latest.values()].filter((s) => s.state === "poison").map((s) => s.pubkey!);
}

/**
 * Derive {@link ChatAttendeeStatus} from data Admin already holds: the roster's
 * `chat_keys`, the 21606 statuses sealed to E_id, and (when this browser's chat
 * session is on this event) the group's real member list. A `cleared` status
 * newer than a poison on the same stage resolves it.
 */
export function chatStatusFor(
  pubkey: string,
  chatKeys: { pubkey: string }[] | undefined,
  statuses: CoordinatorStatusContent[] | undefined,
  memberDevices: string[] | undefined,
): ChatAttendeeStatus {
  const latestPoison = (stage: string): boolean => {
    const mine = (statuses ?? [])
      .filter((s) => s.pubkey === pubkey && s.stage === stage && (s.state === "poison" || s.state === "cleared"))
      .sort((a, b) => b.at - a.at);
    return mine[0]?.state === "poison";
  };
  const keys = (chatKeys ?? []).map((k) => k.pubkey);
  const inRoom = !!memberDevices && keys.some((k) => memberDevices.includes(k));
  if (inRoom) return "in-room";
  if (latestPoison(CHAT_SYNC_STAGE)) return "stuck";
  if (latestPoison(CHAT_ATTESTATION_STAGE)) return "refused";
  if (keys.length === 0) return "not-yet";
  return memberDevices ? "waiting" : "attested";
}

export interface AdminPerson {
  pubkey: string;
  role: "attendee" | "organizer";
  name?: string;
  /**
   * False when neither a recent join-request/submission nor a directory entry is
   * available for this roster member — the card renders an "intake details
   * unavailable" note but KEEPS its revoke/reprocess controls (UX-A1).
   */
  intakeAvailable: boolean;
  profile?: AttendeeProfile;
  media?: MediaDescriptor[];
  introText?: string;
  hasIntro: boolean;
  op: PersonOpState;
  /** Revoked this session — card shows the outcome instead of flipping to pending. */
  revoked: boolean;
  /** In the roster (durably approved) vs. approved-just-now / revoked only. */
  inRoster: boolean;
  /**
   * This member sent a 21610 asking to leave, and nothing has acted on it.
   *
   * Only reachable on a coordinator-less event: with a coordinator attached the
   * daemon performs the whole revoke chain itself and republishes a roster this
   * person is no longer in, so they never reach this list. Without one, the rumor
   * has no consumer at all — and `visiblePending` correctly filters approved
   * people out of the pending queue, which is where the only existing withdrawal
   * notice lived. So the one person whose withdrawal actually matters, an
   * APPROVED member, was the one nobody could see asking.
   */
  withdrawn: boolean;
  /** They also asked for their data to be purged (`delete_data`). */
  withdrawalRequestedPurge: boolean;
  /** Group-chat status (audit U-3); absent when the event has no chat. */
  chat?: ChatAttendeeStatus;
}

export interface BuildPeopleParams {
  roster: RosterContent | undefined;
  /** Approved just now this session (may not be in the roster yet). */
  sessionApproved: Set<string>;
  /** Revoked just now this session. */
  revoked: Set<string>;
  known: PendingRequest[];
  directory?: DirectoryEntryContent[];
  statuses?: CoordinatorStatusContent[];
  /**
   * Set only for a chat-enabled event (audit U-3). `memberDevices` is this
   * browser's chat session's group roster for THIS event, when it has one.
   */
  chat?: { memberDevices?: string[] };
}

/** True when an approved-person op state should read "failed" for this pubkey. */
function opStateFor(
  pubkey: string,
  statuses: CoordinatorStatusContent[] | undefined,
): PersonOpState {
  if (!statuses) return "ok";
  // Latest attendee-scoped status wins (dedupe already keeps newest per stage);
  // any un-cleared poison referencing this attendee marks them failed.
  const mine = statuses.filter((s) => s.pubkey === pubkey);
  if (mine.some((s) => s.state === "poison")) return "failed";
  return "ok";
}

/**
 * Enumerate the approved section from the durable roster (UX-A1), enriched with
 * recent intake + directory + status. Anyone approved or revoked THIS session is
 * folded in too, so a just-approved attendee still shows before the roster
 * republish lands, and a just-revoked one keeps their card (rendering the outcome)
 * instead of silently re-entering the pending queue.
 */
export function buildApprovedPeople(params: BuildPeopleParams): AdminPerson[] {
  const { roster, sessionApproved, revoked, known, directory, statuses, chat } = params;
  const rosterByPk = new Map(
    (roster?.attendees ?? []).map((a) => [a.pubkey, a] as const),
  );
  const pendingByPk = new Map(known.map((r) => [r.attendeePubkey, r] as const));
  const dirByPk = new Map((directory ?? []).map((e) => [e.pubkey, e] as const));

  // Union of roster members + session-approved + session-revoked, de-duped and
  // ordered: roster order first (stable), then any session-only pubkeys.
  const order: string[] = [];
  const seen = new Set<string>();
  const add = (pk: string) => {
    if (!seen.has(pk)) {
      seen.add(pk);
      order.push(pk);
    }
  };
  for (const a of roster?.attendees ?? []) add(a.pubkey);
  for (const pk of sessionApproved) add(pk);
  for (const pk of revoked) add(pk);

  return order.map((pubkey) => {
    const rosterEntry = rosterByPk.get(pubkey);
    const req = pendingByPk.get(pubkey);
    const dir = dirByPk.get(pubkey);
    const intakeAvailable = !!req || !!dir;
    const profile = dir?.profile ?? req?.profile;
    const media = dir?.media ?? req?.media;
    const introText = dir?.intro_text ?? req?.introText;
    const hasIntro = !!(media && media.length) || !!(introText && introText.trim());
    return {
      pubkey,
      role: rosterEntry?.role ?? "attendee",
      name: dir?.name ?? req?.name,
      intakeAvailable,
      profile,
      media,
      introText,
      hasIntro,
      op: opStateFor(pubkey, statuses),
      revoked: revoked.has(pubkey),
      inRoster: rosterByPk.has(pubkey),
      withdrawn: !!req?.withdrawn,
      withdrawalRequestedPurge: !!req?.withdrawalRequestedPurge,
      ...(chat
        ? { chat: chatStatusFor(pubkey, rosterEntry?.chat_keys, statuses, chat.memberDevices) }
        : {}),
    };
  });
}

// ── Bulk approval (UX-A4) ────────────────────────────────────────────────────

/**
 * `queued` is "not started yet" in the bulk run. `outbox` is "sent to this
 * device's outbox, not to the coordinator yet" (audit SB-03): finished as far as
 * the run is concerned, but neither approved nor failed.
 */
export type BulkItemState = "queued" | "publishing" | "confirmed" | "outbox" | "failed";

export interface BulkItem {
  pubkey: string;
  state: BulkItemState;
  error?: string;
}

/** Final tally for a bulk-approve run: how many confirmed, how many need retry. */
export function summarizeBulk(items: Iterable<BulkItem>): {
  approved: number;
  needRetry: number;
  done: boolean;
} {
  let approved = 0;
  let needRetry = 0;
  let pendingWork = false;
  for (const it of items) {
    if (it.state === "confirmed") approved++;
    else if (it.state === "failed") needRetry++;
    else if (it.state !== "outbox") pendingWork = true;
  }
  return { approved, needRetry, done: !pendingWork };
}

// ── People search / filter (UX-A6) ───────────────────────────────────────────

export type PeopleFilter =
  | "all"
  | "pending"
  | "approved"
  | "no-intro"
  | "processing"
  | "failed"
  | "talk";

export interface FilterablePerson {
  pubkey: string;
  name?: string;
  approved: boolean;
  hasIntro: boolean;
  /**
   * Whether `hasIntro` is known (audit KIMIK31 W-16). False for a roster member
   * whose intake aged out of the inbox window with no directory entry: nothing
   * says they lack an intro, only that it cannot be read here. Omitted = known.
   */
  introKnown?: boolean;
  op: PersonOpState;
  hasTalk: boolean;
}

/**
 * Approved, non-revoked people who KNOWABLY have no intro (W-16). Unavailable
 * intake used to count as missing, so on a long-running community everyone whose
 * join request had aged out showed up as a missing intro, burying the real ones.
 */
export function countMissingIntros(
  people: { revoked: boolean; hasIntro: boolean; intakeAvailable: boolean }[],
): number {
  return people.filter((p) => !p.revoked && p.intakeAvailable && !p.hasIntro).length;
}

/**
 * Apply the admin People search + filter (UX-A6), reusing the participant-roster
 * matching shape. `query` matches a case-insensitive substring of name or pubkey.
 */
export function filterPeople<T extends FilterablePerson>(
  people: T[],
  filter: PeopleFilter,
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  return people.filter((p) => {
    if (q && !(p.name?.toLowerCase().includes(q) || p.pubkey.toLowerCase().includes(q))) {
      return false;
    }
    switch (filter) {
      case "pending":
        return !p.approved;
      case "approved":
        return p.approved;
      case "no-intro":
        return p.approved && !p.hasIntro && p.introKnown !== false;
      case "processing":
        return p.op === "processing";
      case "failed":
        return p.op === "failed";
      case "talk":
        return p.hasTalk;
      case "all":
      default:
        return true;
    }
  });
}
