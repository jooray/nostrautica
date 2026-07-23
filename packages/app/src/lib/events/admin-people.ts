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
 */
export function visiblePending(
  known: PendingRequest[],
  isApproved: (pubkey: string) => boolean,
  revoked: Set<string>,
  rejected: Set<string> = new Set(),
): PendingRequest[] {
  return known.filter(
    (r) =>
      !isApproved(r.attendeePubkey) &&
      !revoked.has(r.attendeePubkey) &&
      !rejected.has(r.attendeePubkey),
  );
}

/** Operational state of an approved person, derived from 21606 statuses. */
export type PersonOpState = "ok" | "processing" | "failed";

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
  const { roster, sessionApproved, revoked, known, directory, statuses } = params;
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
    };
  });
}

// ── Bulk approval (UX-A4) ────────────────────────────────────────────────────

export type BulkItemState = "queued" | "publishing" | "confirmed" | "failed";

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
    else pendingWork = true;
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
  op: PersonOpState;
  hasTalk: boolean;
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
        return p.approved && !p.hasIntro;
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
