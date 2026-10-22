/**
 * Organizer-side flows for the walking skeleton (spec §8, no coordinator). The
 * organizer holds the E_inbox secret and unwraps inbound submissions; on approval
 * it grants the ECK (21602) and publishes the attendee's directory entry (31603)
 * and the roster index (31604), both under the ECK.
 *
 * Directory/roster are authored by the discoverable publisher pubkey =
 * coordinator (if configured) else E_id — so attendees can find them from the
 * event coordinate alone. When no coordinator, the organizer signs these with
 * the E_id secret.
 */
import {
  finalizeEvent,
  getPublicKey,
  generateSecretKey,
  type VerifiedEvent,
} from "nostr-tools/pure";
import { nsecEncode } from "nostr-tools/nip19";

import {
  configForSpace,
  KIND_GIFT_WRAP,
  KIND_JOIN_REQUEST,
  KIND_PROFILE_SUBMISSION,
  KIND_ATTENDEE_WITHDRAWAL,
  withdrawalContentSchema,
  KIND_KEY_GRANT,
  KIND_DIRECTORY_ENTRY,
  KIND_ROSTER,
  MAX_ROSTER,
  splitRoster,
  mergeRosterPages,
  rosterContinuationDs,
  rosterPageD,
  KIND_MATCH_LIST,
  KIND_MATCH_MATRIX,
  KIND_DELETION,
  giftwrapSince,
  GIFTWRAP_MAX_BACKDATE_SEC,
  unwrapRumor,
  eckEncrypt,
  eckDecrypt,
  generateEck,
  base64ToBytes,
  bytesToBase64,
  hexToBytes,
  bytesToHex,
  blindedD,
  joinRequestContentSchema,
  profileSubmissionContentSchema,
  inviteListContentSchema,
  isInviteValid,
  inviteHash,
  buildEventConfig,
  wrapRumor,
  type TalksMode,
  type ChatBackend,
  KIND_INVITE_LIST,
  KIND_APP_DATA,
  KIND_COORDINATOR_GRANT,
  KIND_ADMIN_COMMAND,
  KIND_ORGANIZER_GRANT,
  EVENT_INBOX_RUMOR_KINDS,
  ADMIN_COMMAND_TTL_SEC,
  type EventKeysBackup,
  type EventConfig,
  type InviteProof,
  type AttendeeProfile,
  type MediaDescriptor,
  type EckVersion,
  type RosterContent,
  type RevisionKey,
  pickLatest,
  revisionSupersedes,
  supersedes,
  parseMemberOfTags,
  eckFingerprint,
  readEckTag,
  eckCandidates,
  canonicalEck,
  unionEck,
  eckCollisionIds,
  type EckRef,
  mergeEventKeysBackups,
  eventKeysBackupSchema,
  MAX_ORGANIZERS,
  MAX_PRIOR_INBOXES,
} from "@nostrautica/protocol";
import type { GiftWrap } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "./event-context.js";
import type { EventKeys } from "./keystore.js";
import { loadEventKeys, currentEck, saveEventKeys, activeKeystoreOwner, adoptConfigInbox } from "./keystore.js";
import { fetchEvents, fetchEventsRelayOnly } from "$lib/nostr/ndk.js";
import { onlyVerified, onlyByAuthors } from "$lib/nostr/verify.js";
import { publishOrQueue, toOutcome, type PublishOutcome } from "$lib/nostr/publish-queue.js";
import { publishMonotonic } from "$lib/nostr/monotonic.js";
import { withMutationLock } from "$lib/nostr/mutation-lock.js";
import { chatInteropRelays, chatRelaysOf, unionRelays } from "$lib/nostr/relays.js";
import { publishAccountGiftWrap } from "$lib/nostr/giftwrap-routing.js";
import { activeCacheOwner, cacheGeneration, cacheGet, cacheSet } from "$lib/cache/persist.js";
import {
  grantParentField,
  fetchNewestConfig,
  fetchNewestSignedConfig,
  assertConfigNotStale,
} from "./hierarchy.js";

// Admin surfaces cache their decrypted/derived results owner-scoped so the page
// paints instantly and refreshes in parallel (CACHING-PLAN §2.11). Wiped on
// logout. The relay-only scans still run every refresh (HARD CONSTRAINT 1).
function pendingKey(coordinate: string): string {
  return `pending:${coordinate}`;
}
function coordSeenKey(coordinate: string): string {
  return `coordseen:${coordinate}`;
}

/** Cached pending join queue for a coordinate (no network), or undefined. */
export function cachedPending(coordinate: string): PendingRequest[] | undefined {
  return cacheGet<PendingRequest[]>(pendingKey(coordinate))?.data;
}
/** Cached coordinator last-seen for a coordinate (no network), or undefined. */
export function cachedCoordinatorLastSeen(coordinate: string): number | undefined {
  return cacheGet<number>(coordSeenKey(coordinate))?.data;
}

// ── "This device has seen a published X" tripwire ─────────────────────────────
//
// Both read-modify-write republishes in this module — the 31604 roster and the
// 31601 invite list — are WHOLE-DOCUMENT rewrites: what the read returned is what
// gets published, and both publishers deliberately stamp the result NEWER than
// what they read (buildRosterEvents' `base + 1`, publishMonotonic's tie-break
// bump) so the rewrite always wins the replaceable-event race. Which means a lost
// read is not a failed operation, it is silent destruction: one empty answer from
// a struggling venue-Wi-Fi relay republishes as "this event has one attendee" or
// "these three are the only invite codes", and that answer wins for everybody.
//
// On the wire, "no relay answered" and "nothing was ever published" are the same
// event set: empty. What IS knowable is whether THIS device has seen one before —
// so a mark is written whenever a read succeeds or a republish is built, and an
// empty read AFTER a mark is a lost read, never a first publish. Persistent and
// owner-scoped, because a flaky network is exactly what makes people reload.
//
// A tripwire, not a lock: an organizer's second device that has never loaded the
// roster still cannot tell the two apart, and neither can a fresh browser profile.
// It catches the sequence that actually bites (approve, Wi-Fi drops, approve
// again), and it never blocks a genuine first publish.
function seenKey(coordinate: string, what: "roster" | "invites"): string {
  return `published:${what}:${coordinate}`;
}
function markPublished(coordinate: string, what: "roster" | "invites", at: number): void {
  // Stamped with the wall clock, not `at`: this is a monotonic "we got this far"
  // latch, and stamping it with a roster's own created_at would let an older
  // roster's mark lose latest-wins and never land.
  cacheSet(seenKey(coordinate, what), at, Math.floor(Date.now() / 1000));
}
function hasSeenPublished(coordinate: string, what: "roster" | "invites"): boolean {
  return cacheGet<number>(seenKey(coordinate, what)) !== undefined;
}

export interface PendingRequest {
  attendeePubkey: string;
  name: string;
  message: string;
  rsvpPublic: boolean;
  profile?: AttendeeProfile;
  media?: MediaDescriptor[];
  /** A plain-text intro (spec F1) from a 21601 submission — see fetchPending. */
  introText?: string;
  invite?: InviteProof;
  /**
   * `member_of` claims on the join (§15): "I am approved for this event of your
   * community". Unverified here; hierarchy.ts#verifyQueueMembership checks them.
   */
  memberOf?: { child: string; by: string; sig: string }[];
  rumorCreatedAt: number;
  /**
   * This attendee sent a 21610 withdrawal that is NEWER than their join.
   *
   * Only meaningful on a coordinator-less event: with a coordinator attached, the
   * daemon acts on the 21610 itself and the roster it republishes is the truth.
   * Without one, nothing consumed the rumor at all — see the scan below.
   */
  withdrawn?: boolean;
  /** `delete_data` from that withdrawal: the attendee asked for a data purge. */
  withdrawalRequestedPurge?: boolean;
}

/** The publisher pubkey for directory/roster: coordinator if set, else E_id. */
export function directoryPublisher(ctx: EventContext): string {
  return ctx.config.coordinator ?? ctx.config.eidPubkey;
}

/**
 * Authors whose coordinator-authored records (31603/31604/31605/31606/31610) a
 * reader accepts (NIP §3.7 record-authority pinning): the coordinator currently
 * named in `ctx.config` (the newest fetchable 31600 the caller loaded), plus E_id
 * (which authors these when the event has no coordinator, and is always a trusted
 * authority). Records by a formerly assigned coordinator are excluded, so a
 * detach/replace stops them being trusted. Pair with `onlyByAuthors`.
 */
export function acceptedRecordAuthors(ctx: EventContext): string[] {
  return ctx.config.coordinator
    ? [ctx.config.coordinator, ctx.config.eidPubkey]
    : [ctx.config.eidPubkey];
}

type PendingSubmission = {
  key: RevisionKey;
  profile: AttendeeProfile;
  media: MediaDescriptor[];
  introText?: string;
};
type PendingWithdrawal = { id: string; created_at: number; deleteData: boolean };

/**
 * The per-attendee winners of every inbox scan so far, persisted (owner-scoped)
 * so the next scan only has to read what is new. Holding the WINNERS rather than
 * the finished queue is what makes that safe: a submission that arrives after
 * its join has left the read window still folds into the join it belongs to,
 * because the join is in here.
 */
interface PendingScanState {
  /** Unix seconds of the last scan that covered everything up to then. */
  cursor?: number;
  joins: Record<string, PendingRequest>;
  joinIds: Record<string, string>;
  subs: Record<string, PendingSubmission>;
  withdrawals: Record<string, PendingWithdrawal>;
}

function pendingStateKey(coordinate: string): string {
  return `pendingscan:${coordinate}`;
}

/** Page size and page cap for the first, full read of an event's inbox. */
const PENDING_PAGE_SIZE = 500;
const PENDING_MAX_PAGES = 20;

/**
 * The E_inbox wraps to fold in. With a cursor: everything since it, minus the
 * NIP-59 backdating allowance and a day of slack (the DM scan's rule). Without
 * one (first scan of this event on this device): the whole history, paged
 * backwards; `complete` is false if the page cap or a stalled page stopped it.
 */
async function readInboxWraps(
  ctx: EventContext,
  inboxPubkeys: string[],
  cursor: number | undefined,
): Promise<{ wraps: GiftWrap[]; complete: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  if (cursor !== undefined) {
    const since = Math.min(giftwrapSince(now), cursor - GIFTWRAP_MAX_BACKDATE_SEC - 24 * 60 * 60);
    // Relay-only: join requests must not be lost to the cache/EOSE race (see ndk.ts).
    const wraps = (await fetchEventsRelayOnly(
      { kinds: [KIND_GIFT_WRAP], "#p": inboxPubkeys, since },
      ctx.config.relays,
    )) as unknown as GiftWrap[];
    return { wraps, complete: true };
  }
  const seen = new Set<string>();
  const wraps: GiftWrap[] = [];
  let until: number | undefined;
  for (let page = 0; page < PENDING_MAX_PAGES; page++) {
    const filter: Record<string, unknown> = { kinds: [KIND_GIFT_WRAP], "#p": inboxPubkeys, limit: PENDING_PAGE_SIZE };
    if (until !== undefined) filter.until = until;
    const batch = (await fetchEventsRelayOnly(filter, ctx.config.relays)) as unknown as GiftWrap[];
    let added = 0;
    let oldest: number | undefined;
    for (const w of batch) {
      if (!seen.has(w.id)) {
        seen.add(w.id);
        wraps.push(w);
        added++;
      }
      if (oldest === undefined || w.created_at < oldest) oldest = w.created_at;
    }
    if (batch.length < PENDING_PAGE_SIZE) return { wraps, complete: true };
    if (added === 0 || oldest === undefined) return { wraps, complete: false };
    until = oldest; // inclusive: the boundary second is re-read, the id dedupe absorbs it
  }
  return { wraps, complete: false };
}

/**
 * Fetch and unwrap all inbound gift wraps to E_inbox, collapsing to the latest
 * join request + submission per attendee (latest by rumor created_at wins).
 *
 * It used to read only `giftwrapSince()` (the last 3 days) and then REPLACE the
 * cached queue with that window. A join request sent four days before the
 * organizer opened Admin was in neither, and on a coordinator-less event this
 * queue is the only place an approval can happen: the attendee waited forever
 * and nobody could see they had asked (audit DS41-011). The first scan on a
 * device now reads the whole inbox (paged), later scans read from a persisted
 * cursor, and the per-attendee winners carry over between scans.
 */
export async function fetchPending(
  ctx: EventContext,
  keys: EventKeys,
): Promise<PendingRequest[]> {
  if (!keys.einboxNsecHex) throw new Error("missing E_inbox key");
  // Read the current E_inbox AND any prior inbox retained after a rotation (NIP §3.7):
  // pre-rotation submissions were sealed to a superseded inbox the organizer still
  // holds, so history stays readable across a detach/replace.
  const inboxSks = [keys.einboxNsecHex, ...(keys.priorEinboxNsecs ?? [])].map((h) => hexToBytes(h));
  const inboxPubkeys = inboxSks.map((sk) => getPublicKey(sk));
  // Scope and generation as of NOW (audit R-32). The relay read below runs for
  // seconds, often detached (prefetch), and an account switch in that window
  // used to file this identity's decrypted queue under whoever was active when
  // it finished. Writes go to the captured owner, fenced on the generation, so
  // a switch or logout since drops them.
  const cacheOwner = activeCacheOwner() ?? undefined;
  const gen = cacheGeneration();
  const state = cacheGet<PendingScanState>(pendingStateKey(ctx.coordinate), cacheOwner)?.data;
  const scanStartedAt = Math.floor(Date.now() / 1000);
  const { wraps, complete } = await readInboxWraps(ctx, inboxPubkeys, state?.cursor);

  // Start from the winners of earlier scans (copies: the fold below mutates).
  const byAttendee = new Map<string, PendingRequest>(
    Object.entries(state?.joins ?? {}).map(([k, v]) => [k, { ...v }]),
  );
  // The winning join rumor's id per attendee, so equal-created_at siblings apply
  // the global §3.1 tie-break (lowest id) rather than non-deterministic arrival
  // order (audit P4).
  const joinRumorId = new Map<string, string>(Object.entries(state?.joinIds ?? {}));
  const submissions = new Map<string, PendingSubmission>(Object.entries(state?.subs ?? {}));

  /** Unwrap a wrap with whichever inbox secret it was sealed to (current or prior). */
  const unwrapAny = (wrap: GiftWrap) => {
    for (const sk of inboxSks) {
      try {
        // NIP §5/§6.1: E_inbox is a PUBLIC address anyone can seal to, so the
        // organizer's read of it accepts only the attendee-authored kinds. A
        // grant or an admin command sealed here is not an inbox rumor.
        return unwrapRumor(wrap, sk, EVENT_INBOX_RUMOR_KINDS);
      } catch {
        /* try the next inbox secret */
      }
    }
    return undefined;
  };

  /** Newest 21610 per attendee, by the same (created_at, lowest id) tie-break. */
  const withdrawals = new Map<string, PendingWithdrawal>(Object.entries(state?.withdrawals ?? {}));

  for (const wrap of wraps) {
    const rumor = unwrapAny(wrap);
    if (!rumor) continue; // not ours / malformed
    if (rumor.kind === KIND_JOIN_REQUEST) {
      let content;
      try {
        content = joinRequestContentSchema.parse(JSON.parse(rumor.content));
      } catch {
        continue;
      }
      const invite = parseInviteTag(rumor.tags);
      const memberOf = parseMemberOfTags(rumor.tags);
      const prev = byAttendee.get(rumor.pubkey);
      // Join requests carry no `rev`; order them by the global event tie-break —
      // higher created_at, then lowest id on a tie (audit P4). Arrival order is
      // non-deterministic, so first-arrival-wins let two organizers disagree.
      const prevJoinId = joinRumorId.get(rumor.pubkey);
      if (
        !prev ||
        supersedes(
          { id: rumor.id, created_at: rumor.created_at },
          { id: prevJoinId ?? "", created_at: prev.rumorCreatedAt },
        )
      ) {
        byAttendee.set(rumor.pubkey, {
          attendeePubkey: rumor.pubkey,
          name: content.name,
          message: content.message,
          rsvpPublic: content.rsvp_public,
          invite,
          ...(memberOf.length ? { memberOf } : {}),
          rumorCreatedAt: rumor.created_at,
        });
        joinRumorId.set(rumor.pubkey, rumor.id);
      }
    } else if (rumor.kind === KIND_ATTENDEE_WITHDRAWAL) {
      // Nothing read these before. `withdrawAttendee` publishes a 21610 to
      // E_inbox and reports success on the RELAY ACK — but the only handler for
      // the kind is the coordinator's. On an event with no coordinator the
      // rumor sat in the inbox unread forever: the attendee was told they had
      // left, deleted their self-copy and their media, and stayed in the roster
      // and the directory indefinitely, with their ECK still on their device.
      // Surfacing it here at least puts the request in front of the organizer.
      try {
        const parsed = withdrawalContentSchema.parse(JSON.parse(rumor.content));
        if (parsed.a !== ctx.coordinate) continue;
        const prev = withdrawals.get(rumor.pubkey);
        if (!prev || supersedes({ id: rumor.id, created_at: rumor.created_at }, prev)) {
          withdrawals.set(rumor.pubkey, {
            id: rumor.id,
            created_at: rumor.created_at,
            deleteData: parsed.delete_data ?? true,
          });
        }
      } catch {
        continue;
      }
    } else if (rumor.kind === KIND_PROFILE_SUBMISSION) {
      try {
        const parsed = profileSubmissionContentSchema.parse(JSON.parse(rumor.content));
        // Select by (rev, created_at, lowest id) via the shared revision
        // comparator — mirrors the coordinator-backed path (audit P4). The `rev`
        // was previously parsed and discarded, so a delayed revision 1 with a
        // newer clock could replace revision 2 and re-approve removed text/media.
        const candidate: RevisionKey = {
          rev: parsed.rev,
          created_at: rumor.created_at,
          id: rumor.id,
        };
        const prev = submissions.get(rumor.pubkey);
        if (!prev || revisionSupersedes(candidate, prev.key)) {
          submissions.set(rumor.pubkey, {
            key: candidate,
            profile: parsed.profile,
            media: parsed.media,
            introText: parsed.intro_text,
          });
        }
      } catch {
        /* ignore malformed submission */
      }
    }
  }

  // Persist the winners BEFORE the fold below, which mutates requests and
  // synthesizes withdrawal-only ones that are not joins. The cursor only moves
  // when this read covered everything up to now; a full read cut short by the
  // page cap leaves it unset, so the next scan reads the whole history again.
  const nextState: PendingScanState = {
    cursor: complete ? scanStartedAt : state?.cursor,
    joins: Object.fromEntries([...byAttendee].map(([k, v]) => [k, { ...v }])),
    joinIds: Object.fromEntries(joinRumorId),
    subs: Object.fromEntries(submissions),
    withdrawals: Object.fromEntries(withdrawals),
  };
  if (cacheOwner) cacheSet(pendingStateKey(ctx.coordinate), nextState, scanStartedAt, cacheOwner, gen);

  // Fold submissions into their requests.
  for (const [pubkey, sub] of submissions) {
    const req = byAttendee.get(pubkey);
    if (req) {
      req.profile = sub.profile;
      req.media = sub.media;
      req.introText = sub.introText;
    }
  }
  // Mark anyone whose newest withdrawal supersedes their newest join. Ordering
  // matters: someone may withdraw and then re-join, and a stale withdrawal must
  // not shadow the newer request.
  for (const [pubkey, w] of withdrawals) {
    let req = byAttendee.get(pubkey);
    if (!req) {
      // No join request for this person in anything this device has read. Less
      // common now that the first scan reads the whole inbox, but still real: a
      // join older than a capped first read, or one sealed to an inbox this device
      // never held, leaves only the withdrawal. Dropping it here meant their request reached
      // nobody at all, while their client had already deleted their media and their
      // 31602 self-copy and told them it was sent.
      //
      // Synthesized with no name/message on purpose: we genuinely do not have their
      // intake, and `buildApprovedPeople` will fill in the name from the directory
      // entry for anyone actually on the roster — which is who this is about.
      req = {
        attendeePubkey: pubkey,
        name: "",
        message: "",
        rsvpPublic: false,
        rumorCreatedAt: w.created_at,
      };
      byAttendee.set(pubkey, req);
      req.withdrawn = true;
      req.withdrawalRequestedPurge = w.deleteData;
      continue;
    }
    const joinId = joinRumorId.get(pubkey) ?? "";
    if (supersedes({ id: w.id, created_at: w.created_at }, { id: joinId, created_at: req.rumorCreatedAt })) {
      req.withdrawn = true;
      req.withdrawalRequestedPurge = w.deleteData;
    }
  }
  // Oldest first; a same-second tie breaks on the lowest rumor id (§3.1, audit
  // P4), never on arrival order — which differed from the Android's (SB-82).
  const idOf = (pk: string): string => joinRumorId.get(pk) ?? withdrawals.get(pk)?.id ?? "";
  const result = [...byAttendee.values()].sort((a, b) => {
    if (a.rumorCreatedAt !== b.rumorCreatedAt) return a.rumorCreatedAt - b.rumorCreatedAt;
    const ia = idOf(a.attendeePubkey);
    const ib = idOf(b.attendeePubkey);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
  const newestAt = result.reduce((m, r) => Math.max(m, r.rumorCreatedAt), 0);
  if (cacheOwner) cacheSet(pendingKey(ctx.coordinate), result, newestAt, cacheOwner, gen);
  return result;
}

function parseInviteTag(tags: string[][]): InviteProof | undefined {
  const t = tags.find((x) => x[0] === "invite");
  if (t && t[1] && t[2]) return { invitePubkey: t[1], sig: t[2] };
  return undefined;
}

/** Validate an invite proof against the published 31601 hash set (stateless). */
export function checkInvite(
  proof: InviteProof,
  publishedHashes: Set<string>,
  ctx: EventContext,
  attendeePubkey: string,
): boolean {
  return isInviteValid(proof, publishedHashes, ctx.coordinate, attendeePubkey);
}

/**
 * Approve an attendee: grant the ECK (21602), publish their directory entry
 * (31603), and update the roster (31604). Returns the events published.
 */
export async function approveAttendee(
  organizer: AppSigner,
  ctx: EventContext,
  req: PendingRequest,
  role: "attendee" | "organizer" = "attendee",
): Promise<void> {
  // One roster authority (SB-91): with a coordinator attached the approval is a
  // 21604, never a client-authored 31604.
  await assertNoCoordinatorAuthority(ctx);
  const owner = activeKeystoreOwner() ?? undefined;
  const keys = await loadEventKeys(ctx.coordinate, owner);
  if (!keys || keys.role !== "organizer") throw new Error("not the organizer");
  if (!currentEck(keys)) throw new Error("no ECK available");
  if (!keys.eidNsecHex) throw new Error("missing E_id key");
  const eidSk = hexToBytes(keys.eidNsecHex);

  // Read the roster FIRST, with every version held (DS41-002): it decides which
  // key is actually current on the relays — a staged rotation whose roster did go
  // out is promoted here — and a roster under a key this device lacks refuses the
  // whole approval before anything is built on stale custody (SB-90).
  const rosterRead = await loadRoster(ctx, keys, owner);
  assertNoEckCollision(keys);
  // Write under the key the live roster is under, so the entry, its blinded `d`
  // and the republished roster agree with every other entry on it. That is the
  // current version except when this device holds a newer one whose roster never
  // landed; re-keying everyone onto that is a rotation's job, not an approval's.
  const eck = (rosterRead.state === "ok" && rosterRead.eck) || currentEck(keys)!;
  const eckBytes = base64ToBytes(eck.key);

  // 1. Key grant (21602) → attendee, sealed by E_id — the grant comes from the
  // event authority, and the attendee's C2 authentication requires the seal author
  // to be E_id (or the coordinator). Sealing with the organizer's personal key
  // would be rejected as forged (the no-coordinator approval path).
  const grant = {
    v: 2,
    a: ctx.coordinate,
    role,
    eck: keys.eck,
    granted_by: getPublicKey(eidSk),
    // §15.3: when this event belongs to a community, the grant carries the proof
    // that lets the attendee join it. Empty for an unlinked event.
    ...(await grantParentField(ctx, eidSk, req.attendeePubkey)),
  };
  const grantWrap = wrapRumor(eidSk, req.attendeePubkey, {
    kind: KIND_KEY_GRANT,
    content: grant,
  });

  // 2. Directory entry (31603) under ECK, blinded d over ECK, signed by E_id.
  const entryD = blindedD(eckBytes, ctx.coordinate, req.attendeePubkey);
  const entryContent = {
    v: 2,
    pubkey: req.attendeePubkey,
    ...(req.name ? { name: req.name } : {}),
    profile: req.profile ?? { about: "", skills: [], looking_for: "", links: [] },
    media: req.media ?? [],
    // A typed text intro (spec F1) has no media blob, so it must be carried
    // through separately — this was previously dropped by the no-coordinator
    // approve/re-process path (caching verification 2026-07-17): fetchPending
    // parsed intro_text off the 21601 submission but neither PendingRequest nor
    // this entry construction kept it, so a text-only intro never reached the
    // directory entry outside the coordinator path.
    ...(req.introText ? { intro_text: req.introText } : {}),
    updated_at: Math.floor(Date.now() / 1000),
  };
  const entryEvent = finalizeEvent(
    {
      kind: KIND_DIRECTORY_ENTRY,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", entryD],
        ["a", ctx.coordinate],
        ["eck", String(eck.id), eckFingerprint(eckBytes)],
        ["v", "2"],
      ],
      content: eckEncrypt(eckBytes, JSON.stringify(entryContent)),
    },
    eidSk,
  );

  // 3. Roster (31604): add this attendee, republish the whole index. The whole
  //    index — so if the read didn't establish who else is on it, this must not
  //    publish at all (rosterForRewrite throws). Approving one person is never a
  //    reason to remove the rest.
  const { roster, at: rosterAt } = rosterForRewrite(rosterRead, eck.id);
  // Snapshot BEFORE the append: a paginated roster republishes only the pages
  // whose bytes changed, and this is what "changed" is measured against.
  const previous: RosterContent = { ...roster, attendees: [...roster.attendees] };
  if (!roster.attendees.some((a) => a.pubkey === req.attendeePubkey)) {
    roster.attendees.push({ pubkey: req.attendeePubkey, d: entryD, role });
  }
  if (roster.attendees.length > MAX_ROSTER) {
    throw new Error(
      `This event's roster is full (${MAX_ROSTER} members). Remove someone before approving anyone else.`,
    );
  }
  const rosterEvents = buildRosterEvents(ctx, eidSk, eckBytes, eck.id, roster, rosterAt, previous);

  await Promise.all([
    publishAccountGiftWrap(grantWrap as any, req.attendeePubkey, ctx.config.relays),
    publishOrQueue(entryEvent, ctx.config.relays),
    ...rosterEvents.map((e) => publishOrQueue(e, ctx.config.relays)),
  ]);
}

/**
 * Re-issue a key grant carrying the community membership proof to everyone
 * already approved for this event (§15.3). Run once when an organizer links an
 * event that has no coordinator: people who joined before the link would
 * otherwise never be offered the community. The grant is the same ECK set they
 * already hold (receivers union-merge, §6.3), plus the proof. Returns how many
 * were sent; 0 when the roster cannot be read or the event is not linked.
 */
export async function reissueGrantsWithProof(ctx: EventContext): Promise<number> {
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys || keys.role !== "organizer" || !keys.eidNsecHex) return 0;
  if (!currentEck(keys)) return 0;
  const eidSk = hexToBytes(keys.eidNsecHex);
  const read = await loadRoster(ctx, keys);
  if (read.state !== "ok") return 0;
  let sent = 0;
  for (const a of read.roster.attendees) {
    const parent = await grantParentField(ctx, eidSk, a.pubkey, { fresh: sent === 0 });
    if (!parent.parent) return sent; // not linked (yet): nothing to send to anyone
    const wrap = wrapRumor(eidSk, a.pubkey, {
      kind: KIND_KEY_GRANT,
      content: {
        v: 2,
        a: ctx.coordinate,
        role: a.role,
        eck: keys.eck,
        granted_by: getPublicKey(eidSk),
        ...parent,
      },
    });
    await publishAccountGiftWrap(wrap as any, a.pubkey, ctx.config.relays);
    sent++;
  }
  return sent;
}

/**
 * What a roster read actually found. The three cases are deliberately NOT
 * collapsed into "a roster" the way this used to return `{roster, at}` for all
 * of them, because two of them are indistinguishable from an empty roster and
 * every caller here republishes what it is handed.
 */
export type RosterRead =
  /**
   * A 31604 came back and decrypted. `at` is its created_at, always > 0; `eck` is
   * the held version its `eck` tag named and that decrypted it (undefined only
   * when the caller passed raw key bytes).
   */
  | { state: "ok"; roster: RosterContent; at: number; eck?: EckVersion }
  /**
   * A 31604 came back written under a key this device does not hold: its `eck`
   * tag names a newer id, or an `(id, fingerprint)` pair that is not ours (another
   * device rotated, NIP §4.1). Distinct from `unreadable`: the roster is fine, this
   * device's custody is stale.
   */
  | { state: "foreign"; at: number; ref: EckRef }
  /**
   * No 31604 came back at all. `suspect` is true when this device has seen one
   * for this event before, i.e. the empty answer is a lost read and not the
   * event's first roster (see the tripwire note above).
   */
  | { state: "absent"; suspect: boolean }
  /** A 31604 came back but did not decrypt/parse under the ECK we hold. */
  | { state: "unreadable"; at: number };

/**
 * Fetch + decrypt the current roster. This gates a read-modify-write republish
 * (approveAttendee / revoke / rotate): it MUST see the latest roster, including
 * one this same client just published a moment ago in a prior loop iteration
 * (e.g. "Approve all"), or the republish silently drops whoever was added last.
 * `fetchEvents` goes through NDK's cache-adapter-integrated subscription, which
 * can resolve on EOSE before a just-published/just-arrived event is surfaced
 * (same hazard documented on `fetchEventsRelayOnly` in ndk.ts) — use the
 * relay-only variant here, same as the other must-not-miss reads (grants,
 * pending queue) already do.
 *
 * Returns the base event's `at` (created_at) too: the republish must carry a
 * created_at STRICTLY GREATER than the roster it read, or a same-second RMW loop
 * (e.g. "Approve all", where three publishes can land in one wall-clock second)
 * produces sibling replaceable events with equal created_at, and NIP-01's
 * tie-break (keep the lowest id) can leave a stale, fewer-attendee roster winning
 * — silently dropping the last-added attendee. See buildRosterEvents.
 *
 * It used to answer BOTH failure modes — nothing came back, and came back but
 * would not decrypt — with `{roster: {attendees: []}, at: 0}`, and every caller
 * then republished that empty roster at `max(now, 1)`, which by construction wins
 * the race. So an organizer approving one person on venue Wi-Fi could publish a
 * roster containing only that person and erase everyone else from People, for
 * everyone. Through revoke it was worse: `remaining` came out empty, so nobody
 * was re-granted the rotated ECK and every attendee lost the directory in one
 * click. Hence the discriminated result — see {@link rosterForRewrite}, which is
 * how all three write paths consume it.
 */
export async function loadRoster(
  ctx: EventContext,
  /**
   * The custody to read with. With `EventKeys` the key is picked by the roster's
   * own `eck` tag from EVERY version held, pending ones included (audit DS41-002):
   * a device that saved a rotated version but never got as far as publishing it
   * must still read the roster that IS on the relays, and one whose publish did go
   * out adopts the pending version as current here. Raw bytes keep the old
   * single-key read.
   */
  held: Uint8Array | EventKeys,
  owner?: string,
): Promise<RosterRead> {
  const { identifier } = splitCoordinate(ctx.coordinate);
  // Ask for every author we would ACCEPT, not only the current publisher (SB-91),
  // matching attendee.ts `fetchRoster`. With a coordinator attached the request
  // named only the coordinator, so an E_id-authored roster (one this organizer
  // published from a page that had not yet seen the attach) was invisible to its
  // own next read: "absent" on a device that has seen a roster, i.e. every later
  // approve/revoke refused, while attendees were reading that very roster.
  const events = await fetchEventsRelayOnly(
    { kinds: [KIND_ROSTER], authors: acceptedRecordAuthors(ctx), "#d": [identifier] },
    ctx.config.relays,
  );
  // Authority boundary (audit APPK-1) + record-authority pinning (NIP §3.7):
  // re-verify and keep only the currently accepted authors before the §3.1
  // latest-wins pick — the same read attendee.ts `fetchRoster` performs.
  const latest = pickLatest(onlyByAuthors(onlyVerified(events), acceptedRecordAuthors(ctx)));
  if (!latest) {
    return { state: "absent", suspect: hasSeenPublished(ctx.coordinate, "roster") };
  }
  let at = latest.created_at ?? 0;
  let eckBytes: Uint8Array;
  let used: EckVersion | undefined;
  if (held instanceof Uint8Array) {
    eckBytes = held;
  } else {
    const ref = readEckTag(latest.tags);
    const all = unionEck(held.eck, held.pendingEck ?? []);
    const maxHeld = all.reduce((m, v) => Math.max(m, v.id), 0);
    // No tag at all (a writer that predates it): the current key, as before.
    const candidates = ref ? eckCandidates(all, ref) : [canonicalEck(held.eck)].filter((v): v is EckVersion => !!v);
    if (ref && (candidates.length === 0 || ref.id > maxHeld)) return { state: "foreign", at, ref };
    used = candidates.find((v) => {
      try {
        eckDecrypt(base64ToBytes(v.key), latest.content);
        return true;
      } catch {
        return false;
      }
    });
    if (!used) return { state: "unreadable", at };
    eckBytes = base64ToBytes(used.key);
  }
  try {
    const page0 = JSON.parse(eckDecrypt(eckBytes, latest.content)) as RosterContent;
    let roster = page0;
    // A paginated roster (PROTOCOL-NIP.md §6.2) keeps the rest of its membership
    // on `<event-d>:1`… A rewrite path that read only page 0 would republish the
    // event minus everyone past it — the same "erase people by rewriting blind"
    // failure this whole function exists to prevent, just with a subtler cause.
    // So an unreadable continuation page is `unreadable`, not a smaller roster.
    const pages = page0.pages ?? 1;
    if (pages > 1) {
      const rest = await loadRosterPages(ctx, eckBytes, latest.pubkey!, pages);
      if (!rest) return { state: "unreadable", at };
      roster = mergeRosterPages([page0, ...rest.pages]);
      // The republish must beat the newest page it read, not just page 0.
      at = Math.max(at, rest.at);
    }
    markPublished(ctx.coordinate, "roster", at);
    if (used && !(held instanceof Uint8Array)) await promotePending(held, used, owner);
    return { state: "ok", roster, at, ...(used ? { eck: used } : {}) };
  } catch {
    return { state: "unreadable", at };
  }
}

/**
 * The roster on the relays is written under a version this device minted but
 * had only STAGED (`pendingEck`): the rotation's publishes did go out, so that
 * version is current now. Promote it, and everything below it that is still
 * pending, into `eck` and persist (DS41-002).
 */
async function promotePending(keys: EventKeys, used: EckVersion, owner: string | undefined): Promise<void> {
  const pending = keys.pendingEck ?? [];
  if (!pending.some((v) => v.id === used.id && v.key === used.key)) return;
  const promote = pending.filter((v) => v.id <= used.id);
  keys.eck = unionEck(keys.eck, promote);
  const rest = pending.filter((v) => v.id > used.id);
  keys.pendingEck = rest.length > 0 ? rest : undefined;
  await saveEventKeys(keys, owner);
}

/**
 * Pages 1..N-1 of a paginated roster, from the same author whose page 0 we just
 * read, in one relay-only REQ. `undefined` if any page is missing or unreadable
 * — see {@link loadRoster} for why partial is not an answer here.
 */
async function loadRosterPages(
  ctx: EventContext,
  eckBytes: Uint8Array,
  author: string,
  pages: number,
): Promise<{ pages: RosterContent[]; at: number } | undefined> {
  const { eckDecrypt } = await import("@nostrautica/protocol");
  const { identifier } = splitCoordinate(ctx.coordinate);
  const events = await fetchEventsRelayOnly(
    { kinds: [KIND_ROSTER], authors: [author], "#d": rosterContinuationDs(identifier, pages) },
    ctx.config.relays,
  );
  // Same authority boundary as page 0, plus the `a` tag: page N's address could
  // belong to a different space whose own `d` ends in `:N`.
  const usable = onlyByAuthors(onlyVerified(events), [author]).filter((e) =>
    e.tags?.some((t) => t[0] === "a" && t[1] === ctx.coordinate),
  );
  const out: RosterContent[] = [];
  let at = 0;
  for (let page = 1; page < pages; page++) {
    const d = rosterPageD(identifier, page);
    const latest = pickLatest(usable.filter((e) => e.tags?.some((t) => t[0] === "d" && t[1] === d)));
    if (!latest) return undefined;
    try {
      out.push(JSON.parse(eckDecrypt(eckBytes, latest.content)) as RosterContent);
    } catch {
      return undefined;
    }
    at = Math.max(at, latest.created_at ?? 0);
  }
  return { pages: out, at };
}

/**
 * The message every roster write path fails with. One string, because the
 * organizer's question is the same in all three cases ("why didn't that work?")
 * and the honest answer is the same too: we could not establish who is currently
 * on the roster, and rewriting it blind would remove people.
 */
const ROSTER_UNREADABLE =
  "Couldn't read this event's current roster, so nothing was published. " +
  "Rewriting it now would remove everyone already approved. " +
  "Check your connection and try again.";

/**
 * This device's event keys are behind what the relays show: another organizer
 * device or a co-organizer rotated the ECK / E_inbox (audit SB-90, SB-86). Every
 * write that would build on the stale keys refuses with this, and Admin shows it
 * on open (`organizerKeyStatus`).
 */
export class KeysChangedElsewhereError extends Error {
  constructor() {
    super(
      "This event's keys were changed on another device, and this device still holds the old ones. " +
        "Open the event on the device that changed them, or have it send this account a fresh organizer grant.",
    );
    this.name = "KeysChangedElsewhereError";
  }
}

/**
 * Unwrap a {@link RosterRead} for a caller that is about to REPUBLISH the roster.
 * Aborts unless we know what is on it; only a genuine first roster (nothing came
 * back AND this device has never seen one) is allowed through as empty.
 */
function rosterForRewrite(
  read: RosterRead,
  eckCurrent: number,
): { roster: RosterContent; at: number } {
  if (read.state === "ok") return { roster: read.roster, at: read.at };
  if (read.state === "foreign") throw new KeysChangedElsewhereError();
  if (read.state === "unreadable" || read.suspect) throw new Error(ROSTER_UNREADABLE);
  return { roster: { v: 2, eck_current: eckCurrent, attendees: [] }, at: 0 };
}

/**
 * Build the 31604(s) that carry this roster — one event for a roster that fits
 * in a single NIP-44 payload (unchanged, and that is the overwhelming majority),
 * or one per page for a roster that does not (PROTOCOL-NIP.md §6.2).
 *
 * `previous` is the roster as it was READ, and it is what keeps an approval
 * costing one publish rather than N: pages are packed front to back, so
 * appending a member changes only the last page, and any page whose bytes are
 * identical to what is already on the relay is not republished. Pass it only
 * when the pages are comparable — a revoke or a coordinator rotation re-derives
 * every attendee's blinded `d` under a NEW ECK, so every page genuinely changed
 * and those callers pass nothing.
 */
function buildRosterEvents(
  ctx: EventContext,
  eidSk: Uint8Array,
  eckBytes: Uint8Array,
  eckId: number,
  roster: RosterContent,
  baseCreatedAt = 0,
  previous?: RosterContent,
): VerifiedEvent[] {
  const { identifier } = splitCoordinate(ctx.coordinate);
  const pages = splitRoster({ ...roster, eck_current: eckId });
  let onRelay: string[] = [];
  if (previous) {
    try {
      onRelay = splitRoster({ ...previous, eck_current: eckId }).map((p) => JSON.stringify(p));
    } catch {
      // An unsplittable previous roster (over the caps, malformed) tells us
      // nothing about what is on the relay — republish every page.
      onRelay = [];
    }
  }
  // Strictly newer than the roster we read (baseCreatedAt) so this republish
  // always wins the replaceable-event race — see loadRoster. Clamp to now so a
  // steady state (base far in the past) still uses the wall clock.
  const createdAt = Math.max(Math.floor(Date.now() / 1000), baseCreatedAt + 1);
  // Arm the tripwire here rather than at each publish site: this is the single
  // choke point every roster republish goes through, and by the time an event is
  // built we have committed to it (publishOrQueue may durably queue it offline,
  // which still means a roster exists for this event as far as we're concerned).
  markPublished(ctx.coordinate, "roster", createdAt);
  const events: VerifiedEvent[] = [];
  for (const [page, content] of pages.entries()) {
    const json = JSON.stringify(content);
    if (onRelay[page] === json) continue;
    events.push(
      finalizeEvent(
        {
          kind: KIND_ROSTER,
          created_at: createdAt,
          tags: [
            ["d", rosterPageD(identifier, page)],
            ["a", ctx.coordinate],
            ["eck", String(eckId), eckFingerprint(eckBytes)],
            // The event envelope is still wire v2 even when the PAYLOAD declares
            // v3 — see buildRoster in the coordinator's publisher for why an old
            // client must still be able to fetch page 0 in order to fail loudly.
            ["v", "2"],
          ],
          content: eckEncrypt(eckBytes, json),
        },
        eidSk,
      ),
    );
  }
  return events;
}

function splitCoordinate(coordinate: string): { identifier: string } {
  const parts = coordinate.split(":");
  return { identifier: parts.slice(2).join(":") };
}

/**
 * Send an admin command (kind 21604) to the coordinator, sealed by E_id (the
 * coordinator authenticates commands as coming from the event authority). Used
 * for manual approval, recompute, reprocess, and revoke when a coordinator is
 * attached.
 *
 * Returns whether the command actually went out or only reached the durable
 * outbox. The caller must not show "approved"/"revoked" for a queued one: the
 * coordinator has not acted, and for a revoke the member keeps their chat leaf
 * until it does (audit SB-03).
 */
export async function sendAdminCommand(
  ctx: EventContext,
  cmd: "approve" | "recompute" | "reprocess" | "revoke" | "talk_publish" | "talk_reject",
  args: Record<string, unknown> = {},
): Promise<PublishOutcome> {
  if (!ctx.config.coordinator) throw new Error("no coordinator attached");
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys?.eidNsecHex) throw new Error("organizer E_id key not available");
  const eidSk = hexToBytes(keys.eidNsecHex);
  // Replay horizon (NIP §3.4): the command is void after created_at + 48h, so an
  // old command can never re-execute from a coordinator backfill/restore.
  const expires = Math.floor(Date.now() / 1000) + ADMIN_COMMAND_TTL_SEC;
  const wrap = wrapRumor(eidSk, ctx.config.coordinator, {
    kind: KIND_ADMIN_COMMAND,
    content: { v: 2, a: ctx.coordinate, cmd, args, expires },
  });
  return toOutcome(await publishAccountGiftWrap(wrap as any, ctx.config.coordinator, ctx.config.relays));
}

/**
 * Add a co-organizer (spec §6.1, §13). Gift-wraps the event's keys (E_id, E_inbox,
 * ECK) to the co-organizer's pubkey so they get full organizer custody — they can
 * edit the event, approve attendees, and manage the coordinator. Their client
 * picks it up via the normal grant-receiving path.
 *
 * Returns the publication outcome. The caller MUST NOT report this as done on a
 * bare resolve: `publishOrQueue` persists to the durable outbox when WSS is
 * blocked or every retry fails, and the settings page used to paint a flat
 * "Sent ✓" either way — telling one organizer the hand-off had happened while
 * the wrap was still sitting in this device's IndexedDB and the other device
 * waited forever.
 */
export async function addCoOrganizer(
  organizer: AppSigner,
  ctx: EventContext,
  coOrganizerPubkey: string,
): Promise<PublishOutcome> {
  const owner = activeKeystoreOwner() ?? undefined;
  const keys = await loadEventKeys(ctx.coordinate, owner);
  if (!keys || keys.role !== "organizer" || !keys.eidNsecHex || !keys.einboxNsecHex) {
    throw new Error("organizer keys not available on this device");
  }
  // Remember who holds custody (audit SB-90): every later rotation re-issues the
  // grant to them, since nothing else ever tells a co-organizer the keys moved.
  const own = await Promise.resolve()
    .then(() => organizer.getPublicKey())
    .catch(() => undefined);
  if (coOrganizerPubkey !== own) {
    keys.coOrganizers = [...new Set([...(keys.coOrganizers ?? []), coOrganizerPubkey])];
    await saveEventKeys(keys, owner);
  }
  return toOutcome(await sendOrganizerGrant(ctx, keys, coOrganizerPubkey, own));
}

/**
 * Gift-wrap a 21605 carrying this device's full custody to one account. Sealed by
 * E_id: the recipient's C2 authentication requires the seal author to be E_id
 * (authenticateOrganizerGrant). `organizers` names every account known to hold
 * custody, the sender's own included, so the recipient can re-issue to all of
 * them on its own rotations (SB-90); `prior_einbox_nsecs` keeps old submissions
 * readable after one.
 */
async function sendOrganizerGrant(ctx: EventContext, keys: EventKeys, to: string, ownPubkey: string | undefined) {
  const eidSk = hexToBytes(keys.eidNsecHex!);
  const organizers = [...new Set([...(ownPubkey ? [ownPubkey] : []), ...(keys.coOrganizers ?? [])])].slice(0, MAX_ORGANIZERS);
  const wrap = wrapRumor(eidSk, to, {
    kind: KIND_ORGANIZER_GRANT,
    content: {
      v: 2,
      a: ctx.coordinate,
      eid_nsec: keys.eidNsecHex,
      einbox_nsec: keys.einboxNsecHex,
      eck: keys.eck,
      config_relays: ctx.config.relays,
      granted_by: getPublicKey(eidSk),
      ...(organizers.length > 0 ? { organizers } : {}),
      ...(keys.priorEinboxNsecs?.length ? { prior_einbox_nsecs: keys.priorEinboxNsecs.slice(-MAX_PRIOR_INBOXES) } : {}),
    },
  });
  return publishAccountGiftWrap(wrap as any, to, ctx.config.relays);
}

/**
 * Re-issue organizer custody to every known co-organizer after a rotation of the
 * E_inbox and/or ECK (audit SB-90). A co-organizer is a different account and not
 * an attendee: it receives neither the attendee re-grants nor this account's
 * backup, so without this its pending queue went silently empty (joins sealed to
 * the new inbox) and its People tab unreadable (roster under the new ECK).
 * Best-effort per recipient; returns how many were handed to the relays/outbox.
 */
async function reissueOrganizerGrants(organizer: AppSigner, ctx: EventContext, keys: EventKeys): Promise<number> {
  const co = keys.coOrganizers ?? [];
  if (co.length === 0 || !keys.eidNsecHex || !keys.einboxNsecHex) return 0;
  const own = await Promise.resolve()
    .then(() => organizer.getPublicKey())
    .catch(() => undefined);
  let sent = 0;
  for (const to of co) {
    if (to === own) continue;
    try {
      await sendOrganizerGrant(ctx, keys, to, own);
      sent++;
    } catch (e) {
      console.warn("[organizer] could not re-issue organizer custody to", to, e);
    }
  }
  return sent;
}

/** How often the organizer-grant wait re-checks while the page stays open. */
export const ORGANIZER_GRANT_POLL_MS = 4000;

/**
 * One pass of the "do I hold the organizer keys yet?" check behind the Admin /
 * Event-settings grant-wait card: pull any newly-arrived gift wraps into local
 * custody, then re-read this device's keys for the coordinate. Resolves to the
 * organizer keys once this device holds them, undefined while it doesn't.
 *
 * `signer` is nullable ON PURPOSE, and a null one skips ONLY the grant scan. Two
 * different things are missing during a session restore and both used to read as
 * "you are not the organizer": there is no signer to unwrap inbound 21605 grants
 * with, AND there is no active keystore owner yet (the session sets it in
 * `adopt()`), so `loadEventKeys` returns undefined even on a device that already
 * holds the keys. With a NIP-46 signer the layout deliberately does not await the
 * restore — it is a bunker connect plus a getPublicKey round-trip — so a page can
 * mount squarely inside that window. Re-reading the keystore on every pass, with
 * or without a signer, is what lets both resolve on a later pass instead of
 * needing a navigation away and back.
 *
 * `receiveGrants` is injected rather than imported: it lives in attendee.ts,
 * which already imports this module, and an import cycle is not worth saving the
 * caller one argument.
 */
export async function checkForOrganizerGrant(
  coordinate: string,
  signer: AppSigner | null,
  receiveGrants: (signer: AppSigner) => Promise<unknown>,
): Promise<EventKeys | undefined> {
  if (signer) await receiveGrants(signer);
  const keys = await loadEventKeys(coordinate);
  return keys?.role === "organizer" ? keys : undefined;
}

export interface OrganizerGrantPollOptions {
  coordinate: string;
  /** Read FRESH on every tick — never captured once (see below). */
  signer: () => AppSigner | null;
  receiveGrants: (signer: AppSigner) => Promise<unknown>;
  /** Stop the wait: the page was destroyed, or the keys arrived another way. */
  stopped: () => boolean;
  /** Called once, with the keys, as soon as this device holds organizer custody. */
  onGranted: (keys: EventKeys) => void | Promise<void>;
  /** After every completed pass, with whether a signer was available for it. */
  onChecked?: (signerReady: boolean) => void;
  intervalMs?: number;
}

/**
 * Poll {@link checkForOrganizerGrant} until this device is granted organizer
 * custody — the receiving half of {@link addCoOrganizer} (spec §6.1 co-organizer
 * hand-off, and the same path a second device of the same organizer takes).
 *
 * The loop starts UNCONDITIONALLY, before any signer exists, and re-reads
 * `signer()` every pass. Its predecessor opened with an `if (!session.signer)
 * return` and was started exactly once from `onMount`: on a NIP-46 device whose
 * session restore hadn't finished yet, the wait ended before it ever ran a single
 * check. `session.npub` painted a second later, so the card looked perfectly
 * healthy while nothing at all was polling — the grant sat on the relay, a reload
 * replayed the same race, and only navigating away and back (a remount with the
 * signer already present) unstuck it (device-B report 2026-07-24).
 *
 * Every pass is fully guarded, too. `receiveGrants` was `.catch()`-ed but
 * `loadEventKeys` was not, so a single rejected keystore read rejected the loop's
 * promise — which both callers `void` — and the wait died silently for the rest
 * of the page's life.
 */
export async function pollForOrganizerGrant(opts: OrganizerGrantPollOptions): Promise<void> {
  const intervalMs = opts.intervalMs ?? ORGANIZER_GRANT_POLL_MS;
  while (!opts.stopped()) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (opts.stopped()) return;
    const signer = opts.signer();
    let granted: EventKeys | undefined;
    try {
      granted = await checkForOrganizerGrant(opts.coordinate, signer, opts.receiveGrants);
    } catch {
      /* an unreachable relay, a declined signer prompt, a storage hiccup — one
         bad pass must never end the wait; the next tick retries it */
    }
    opts.onChecked?.(signer !== null);
    if (opts.stopped()) return;
    if (!granted) continue;
    try {
      await opts.onGranted(granted);
    } catch {
      /* the caller surfaces its own load failure; custody is already ours */
    }
    return;
  }
}

/**
 * Coordinator liveness (UI-SUGGESTIONS #16): the newest event the coordinator
 * pubkey has authored for this event. A dead coordinator otherwise looks
 * identical to a working one. Pure read — the coordinator signs roster/directory
 * (31603/31604), match lists (31605), and match matrices (31606); the newest of
 * any of those is its last sign of life. Returns undefined if it's authored
 * nothing yet.
 */
export async function fetchCoordinatorLastSeen(
  ctx: EventContext,
): Promise<number | undefined> {
  if (!ctx.config.coordinator) return undefined;
  const { identifier } = splitCoordinate(ctx.coordinate);
  const events = await fetchEvents(
    {
      kinds: [KIND_DIRECTORY_ENTRY, KIND_ROSTER, KIND_MATCH_LIST, KIND_MATCH_MATRIX],
      authors: [ctx.config.coordinator],
      "#a": [ctx.coordinate],
    },
    ctx.config.relays,
  ).catch(() => []);
  // Roster carries #d=identifier but per-attendee entries/matches use blinded d's;
  // filtering by #a (the event coordinate) catches them all.
  let newest = 0;
  for (const e of events) if ((e.created_at ?? 0) > newest) newest = e.created_at ?? 0;
  // Fall back to the roster #d query in case a relay ignores #a on some kinds.
  if (newest === 0) {
    const roster = await fetchEvents(
      { kinds: [KIND_ROSTER], authors: [ctx.config.coordinator], "#d": [identifier] },
      ctx.config.relays,
    ).catch(() => []);
    for (const e of roster) if ((e.created_at ?? 0) > newest) newest = e.created_at ?? 0;
  }
  const seen = newest || undefined;
  if (seen !== undefined) cacheSet(coordSeenKey(ctx.coordinate), seen, seen);
  return seen;
}

export interface GeneratedInvite {
  label: string;
  nsec: string; // the invite code (an nsec, spec §6.5)
  link: string; // #/e/:naddr/join?code=<nsec>
  /**
   * Distinct redemptions allowed; INVITE_USES_UNLIMITED (0) for unbounded.
   * Absent means single-use — the same thing an omitted `uses` means on the
   * wire, so a reader never has to distinguish "old code" from "one person".
   */
  uses?: number;
  /** Unix seconds after which the code stops auto-approving. */
  exp?: number;
}

/** How a batch of codes may be redeemed (§6.5). Omitted ⇒ one code, one person. */
export interface InviteOptions {
  uses?: number;
  exp?: number;
}

/**
 * The `exp` a shared entry code should carry, from the organizer's "valid for
 * (hours)" field. `undefined` means the code never stops auto-approving: `exp`
 * is then omitted from the published entry entirely, which is the only way to
 * say "no expiry" on the wire — the field is `positive()` in the schema, so
 * there is no sentinel value for it and 0 is not sayable.
 *
 * 0 means exactly that, matching the headcount field beside it, where 0 has
 * always meant "no limit". An emptied field is the same answer: `bind:value` on
 * a number input hands back `null`, and an organizer who cleared the box did not
 * ask for a deadline either.
 *
 * This used to be `Math.max(1, hours)` inline in the form handler, which turned
 * "no expiry" into the SHORTEST window the form can express — one hour. Two
 * shared codes for a live community were minted that way before anyone worked
 * out why, and both looked fine from the organizer's side: whoever scanned
 * inside the hour walked straight in, and everyone after them landed in the
 * approval queue with nothing on screen saying the code had lapsed (production
 * incident, 2026-09-15). Silently substituting the most restrictive possible
 * value for the most permissive one is the specific failure this guards.
 */
export function sharedInviteExp(
  hours: number | null | undefined,
  nowMs: number,
): number | undefined {
  if (hours == null || !Number.isFinite(hours) || hours <= 0) return undefined;
  return Math.floor(nowMs / 1000) + Math.round(hours * 3600);
}

/**
 * Every invite ever issued for this event: the `{h, label}` set from the
 * published 31601 (replaceable, so it accumulates across every batch the
 * organizer generated, on any of their devices).
 *
 * Two callers, for two reasons. `generateInvites` needs it because labels are
 * numbered off the merged list (`invite-${invites.length + 1}`), which is what
 * makes them unique and monotonic across batches — and because the republish
 * must not drop earlier codes. The "who has joined" export needs it because the
 * labels ARE the report: the codes themselves are never stored anywhere, so this
 * plaintext hash+label list is the only durable record that a given invite was
 * ever handed out.
 *
 * THROWS when the list cannot be established, rather than answering `[]`. The
 * old comment here reasoned only about the EXPORT layer — which unions with its
 * own persistent cache, so an empty answer genuinely can't erase labels it
 * already knows (see invite-export.ts) — and never followed the OTHER caller
 * through to its publish. `generateInvites` republishes the 31601 with exactly
 * what this returns plus the new hashes; `publishMonotonic` adjusts created_at
 * and never merges content. So one unreachable relay while an organizer minted
 * one more code silently revoked every code already handed out (they are hashes
 * on a replaceable event — there is no other copy), and restarted labelling at
 * `invite-1`, which also corrupts the label↔email join the usage report is built
 * on. "Nothing published yet" and "we couldn't read it" must not be the same
 * answer to a caller that is about to overwrite the thing.
 *
 * Nothing came back is only accepted as "confirmed absent" when this device has
 * never seen a list for this event (see the tripwire note at the top).
 */
export async function fetchPublishedInvites(
  ctx: EventContext,
): Promise<{ h: string; label?: string }[]> {
  const existing = await fetchEvents(
    {
      kinds: [KIND_INVITE_LIST],
      authors: [ctx.config.eidPubkey],
      "#d": [splitCoordinate(ctx.coordinate).identifier],
    },
    ctx.config.relays,
  );
  // Authority boundary: `authors` is a request a relay may ignore, and this list
  // is not just read — `generateInvites` MERGES it into a new 31601 and signs
  // that with E_id. An injected list would therefore get laundered into genuinely
  // published invite hashes, i.e. the injector's own codes would auto-approve.
  const latest = pickLatest(onlyByAuthors(onlyVerified(existing), [ctx.config.eidPubkey]));
  if (!latest) {
    if (hasSeenPublished(ctx.coordinate, "invites")) throw new Error(INVITES_UNREADABLE);
    return [];
  }
  let invites: { h: string; label?: string }[];
  try {
    invites = inviteListContentSchema.parse(JSON.parse(latest.content)).invites;
  } catch {
    // A list exists and we can't read it. Publishing over it would drop every
    // code in it — including, if this is a newer-schema list from a newer build,
    // codes this build simply doesn't understand yet.
    throw new Error(INVITES_UNREADABLE);
  }
  markPublished(ctx.coordinate, "invites", latest.created_at ?? 0);
  return invites;
}

const INVITES_UNREADABLE =
  "Couldn't read this event's published invite list, so no codes were generated. " +
  "Republishing it now would revoke every code already handed out. " +
  "Check your connection and try again.";

/**
 * Generate N invite codes (spec §6.5). Each code IS an nsec; the organizer
 * publishes only sha256(invite-pubkey) in a replaceable 31601, so observers
 * can't enumerate or front-run codes. The nsec rides the link's URL fragment and
 * never touches a server.
 *
 * Single-use by default. `opts.uses` raises the cap for the shared-code case —
 * one QR on the opening slide, everyone in the room scans it — and `opts.exp`
 * bounds how long that lasts. Both are properties of the published entry, not of
 * the key, so the same proof mechanism carries them: the code stays a secret
 * nobody can derive from the event's naddr, and the signature still binds each
 * redemption to the redeemer's own pubkey.
 */
export async function generateInvites(
  organizer: AppSigner,
  ctx: EventContext,
  count: number,
  appBaseUrl: string,
  labelPrefix = "invite",
  opts: InviteOptions = {},
): Promise<GeneratedInvite[]> {
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys?.eidNsecHex) throw new Error("organizer E_id key not available");
  const eidSk = hexToBytes(keys.eidNsecHex);

  // Merge with any already-published invite hashes (replaceable event) — this is
  // also what makes labels monotonic across batches (see fetchPublishedInvites).
  // It throws rather than answering `[]` when it can't establish the published
  // list, and that throw must stay unguarded: the republish below is a whole-
  // document overwrite, so generating on a half-answered read is how every
  // previously issued code gets revoked.
  const invites = await fetchPublishedInvites(ctx);

  const generated: GeneratedInvite[] = [];
  const base = appBaseUrl.replace(/[#/]+$/, "");
  // The link states the event's LANGUAGE as well as the code. `adoptEventLang`
  // can only fire once the 31600 has come back from relays, so an invitee
  // arriving cold off this link watches the splash, the join skeleton and every
  // error state on the way paint in whatever their browser claims, and then flip
  // — and nothing survives the reload. The param is read before the first paint
  // (i18n.init) and remembered as a soft default; it never outranks a language
  // the person picked in Settings themselves. Omitted for English so an ordinary
  // event's links stay byte-identical to what earlier builds emitted.
  const lang = ctx.config.lang;
  const langQuery = lang && lang !== "en" ? `&lang=${encodeURIComponent(lang)}` : "";
  // Only emit `uses`/`exp` when they differ from the implicit default, so an
  // ordinary single-use batch publishes byte-identical entries to before.
  const policy: { uses?: number; exp?: number } = {
    ...(opts.uses !== undefined && opts.uses !== 1 ? { uses: opts.uses } : {}),
    ...(opts.exp !== undefined ? { exp: opts.exp } : {}),
  };
  for (let i = 0; i < count; i++) {
    const sk = generateSecretKey();
    const label = `${labelPrefix}-${invites.length + 1}`;
    invites.push({ h: inviteHash(getPublicKey(sk)), label, ...policy });
    const nsec = nsecEncode(sk);
    generated.push({
      label,
      nsec,
      link: `${base}/#/e/${encodeURIComponent(ctx.naddr)}/join?code=${nsec}${langQuery}`,
      uses: opts.uses ?? 1,
      ...(opts.exp !== undefined ? { exp: opts.exp } : {}),
    });
  }

  const identifier = splitCoordinate(ctx.coordinate).identifier;
  // Monotonic republish (audit P3): the invite list is addressable, and a
  // same-second regeneration must not lose the §3.1 tie-break and silently drop
  // the codes just added/revoked.
  const { createdAt } = await publishMonotonic({
    kind: KIND_INVITE_LIST,
    author: ctx.config.eidPubkey,
    identifier,
    relays: ctx.config.relays,
    sign: (created_at) =>
      finalizeEvent(
        {
          kind: KIND_INVITE_LIST,
          created_at,
          tags: [["d", identifier], ["a", ctx.coordinate], ["v", "2"]],
          content: JSON.stringify({ v: 2, invites }),
        },
        eidSk,
      ),
  });
  // Arm the tripwire: from here on, an empty read for this event is a lost read,
  // not "no codes have ever been issued".
  markPublished(ctx.coordinate, "invites", createdAt);
  return generated;
}

/**
 * Revoke an attendee client-side (no coordinator, spec §6.3, §8). Rotation is
 * forward-only: mint ECK v(n+1), delete the removed entry (NIP-09), re-grant the
 * new ECK to remaining attendees, and republish directory + roster under it. The
 * removed attendee keeps only old versions and cannot read future content.
 */
export async function revokeAttendeeClient(
  organizer: AppSigner,
  ctx: EventContext,
  removedPubkey: string,
  /**
   * The organizer's blinding key, so the rotated ECK reaches the durable 30078
   * backup. Optional only so an existing caller cannot break; a caller that
   * omits it gets a loud warning rather than silent key loss — see the write
   * below.
   */
  blindingKey?: Uint8Array,
): Promise<void> {
  // One roster authority (SB-91): with a coordinator attached the removal is a
  // 21604 and the coordinator rotates; a client rotation here would be a second
  // roster author and a second, colliding ECK mint (SB-86).
  await assertNoCoordinatorAuthority(ctx);
  // Captured once (audit DS41-001): the rotated ECK is saved after a roster read
  // and a directory read, and must land under the identity that read these keys,
  // not whoever is signed in by then.
  const owner = activeKeystoreOwner() ?? undefined;
  const keys = await loadEventKeys(ctx.coordinate, owner);
  if (!keys || keys.role !== "organizer" || !keys.eidNsecHex) {
    throw new Error("organizer keys not available");
  }
  const eidSk = hexToBytes(keys.eidNsecHex);
  const eidPubkey = ctx.config.eidPubkey;
  if (!currentEck(keys)) throw new Error("no ECK available");

  // 1. Read the current roster — BEFORE minting anything — with every version
  //    held, so the roster's own `eck` tag picks the key (DS41-002). See step 2.
  const rosterRead = await loadRoster(ctx, keys, owner);
  const prevEck = (rosterRead.state === "ok" && rosterRead.eck) || currentEck(keys)!;
  const prevEckBytes = base64ToBytes(prevEck.key);

  // Delete the removed attendee's directory entry (NIP-09), addressed by the
  // blinded d the roster lists for them (that is the address it was published
  // at), falling back to the d under the roster's key.
  const listedD =
    rosterRead.state === "ok" ? rosterRead.roster.attendees.find((a) => a.pubkey === removedPubkey)?.d : undefined;
  const removedD = listedD ?? blindedD(prevEckBytes, ctx.coordinate, removedPubkey);
  const deletion = finalizeEvent(
    {
      kind: KIND_DELETION,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["a", `${KIND_DIRECTORY_ENTRY}:${eidPubkey}:${removedD}`],
        ["k", String(KIND_DIRECTORY_ENTRY)],
      ],
      content: "revoked",
    },
    eidSk,
  );

  // 2. The roster read above decides who keeps access: `remaining` is the
  //    complete list of people who get re-granted the rotated ECK and get their
  //    entry re-encrypted under it, and everyone missing from it is, in effect,
  //    revoked too. On a lost read `remaining` came out empty and one revoke
  //    click locked every attendee out of the directory and all future
  //    members-only content, with the roster republished as empty so the damage
  //    propagated to every other client. A roster under a key this device lacks
  //    (another device rotated, SB-90/SB-86) refuses here too.
  //
  //    The ECK mint deliberately happens AFTER this: a throw here must leave the
  //    keystore untouched, or the aborted revoke would still have made a new ECK
  //    version current locally, and this organizer's next post would be encrypted
  //    under a key no attendee was ever granted.
  const { roster, at: rosterAt } = rosterForRewrite(rosterRead, prevEck.id);
  if (!roster.attendees.some((a) => a.pubkey === removedPubkey)) {
    // The person being revoked is not on the roster we just read, so it is not
    // the roster this revoke was decided against — a stale or partial answer,
    // or a roster already rewritten elsewhere. Rotating against it would strand
    // whoever it does list. (A genuine double-revoke lands here too, and saying
    // so is the correct outcome: there is nothing left to revoke.)
    throw new Error(
      "That attendee isn't on the roster we just read, so nothing was published. " +
        "Reload the People list and try again.",
    );
  }
  const remaining = roster.attendees.filter((a) => a.pubkey !== removedPubkey);

  // 3. Mint ECK v(n+1) and build EVERYTHING under it — every re-encrypted
  //    directory entry, every re-grant, the new roster — before making it current.
  //
  //    This used to persist the new ECK first and then walk the attendees one
  //    relay read at a time (up to 8 s each). Closing the tab, losing the network
  //    or one hanging read part-way left this device with v(n+1) as its CURRENT
  //    key while the relays still held the v(n) roster: every later loadRoster
  //    decrypted with the new key, failed, and refused approve/revoke/post with
  //    "Couldn't read this event's current roster" (audit DS41-002). Building is
  //    now one batched read and local crypto; then the key is STAGED (persisted,
  //    not current), published, and only then made current.
  const newEck = mintEck(keys);
  const newId = newEck.id;
  const eckAll = unionEck(keys.eck, [newEck]);
  const newEckBytes = base64ToBytes(newEck.key);
  const rekeyed = await rekeyRoster(ctx, eidSk, prevEck, remaining, newEckBytes, newId, eckAll, {
    keepChatKeys: false,
    held: unionEck(keys.eck, keys.pendingEck ?? []),
  });
  const rosterEvents = buildRosterEvents(ctx, eidSk, newEckBytes, newId, rekeyed.roster, rosterAt);

  await stageEck(keys, newEck, owner);
  // The new ECK must reach the DURABLE backup, not just this device.
  //
  // Every other path that mints an ECK writes the 30078 backup;  this one never
  // did. So a coordinator-less organizer who revoked someone re-encrypted the
  // roster and every directory entry under a key that existed only in this
  // browser. Clear site data, or move to a new phone, and `recoverEventKeys`
  // restores a backup still holding only ECK v1 — leaving the event's own owner
  // permanently unable to read their own roster and directory. Forward-only
  // rotation means there is no way back from that. Written while the version is
  // still staged (as `pending_eck`), so a recovered device holds it but does not
  // treat it as current until it finds the roster that uses it.
  if (blindingKey) {
    await writeEventKeysBackup(organizer, ctx.coordinate, keys, blindingKey, keys.coordinatorGen ?? 0, { owner }).catch(
      (e) => {
        console.warn("[organizer] revoke rotated the ECK but its backup did not publish:", e);
      },
    );
  } else {
    console.warn(
      "[organizer] revoke rotated the ECK with no blinding key — the new key exists only on this device",
    );
  }
  await publishRekeyed(ctx, [deletion], rekeyed, rosterEvents);
  await promotePending(keys, newEck, owner);
  // Co-organizers hold custody but are not attendees: hand them the new key (SB-90).
  await reissueOrganizerGrants(organizer, ctx, keys);
}

/**
 * The next ECK version: one past every id this device holds, staged ones
 * included, so a version minted by an interrupted rotation is never reused for a
 * different key.
 */
function mintEck(keys: EventKeys): EckVersion {
  const id = unionEck(keys.eck, keys.pendingEck ?? []).reduce((m, v) => Math.max(m, v.id), 0) + 1;
  return { id, key: bytesToBase64(generateEck()) };
}

/** Persist a freshly minted version as staged, not current (DS41-002). */
async function stageEck(keys: EventKeys, v: EckVersion, owner: string | undefined): Promise<void> {
  keys.pendingEck = unionEck(keys.pendingEck ?? [], [v]);
  await saveEventKeys(keys, owner);
}

/** Refuse a write while two keys share the current id (NIP §4.1): repair first. */
export class EckCollisionError extends Error {
  constructor() {
    super(
      "This event's member key was changed on two devices at the same time. " +
        "Use \"Repair keys\" on the Admin page, then try again.",
    );
    this.name = "EckCollisionError";
  }
}

function assertNoEckCollision(keys: EventKeys): void {
  const cur = currentEck(keys);
  if (cur && eckCollisionIds(keys.eck).includes(cur.id)) throw new EckCollisionError();
}

interface Rekeyed {
  roster: RosterContent;
  entries: VerifiedEvent[];
  grants: { to: string; wrap: unknown }[];
}

/**
 * Re-key every listed attendee under a new ECK, WITHOUT publishing anything:
 * their directory entry re-encrypted at its new blinded `d`, a 21602 re-grant of
 * the full ECK set sealed by E_id, and the new roster content. Shared by revoke
 * and coordinator rotation, which both used to interleave one relay read and the
 * publishes per attendee with the key change (audit DS41-002).
 *
 * The current entries come from ONE batched read (chunked `#d`), pinned to the
 * accepted record authors and resolved per `d` by §3.1 (DS41-013). An entry that
 * can't be found or decrypted is not republished, as before.
 */
async function rekeyRoster(
  ctx: EventContext,
  eidSk: Uint8Array,
  prevEck: EckVersion,
  attendees: RosterContent["attendees"],
  newEckBytes: Uint8Array,
  newId: number,
  eckAll: EckVersion[],
  /** `held`: every version this device holds; an entry is decrypted with the one
   *  its own `eck` tag names, falling back to the roster's key (`prevEck`). */
  opts: { keepChatKeys: boolean; held: EckVersion[] },
): Promise<Rekeyed> {
  const authors = acceptedRecordAuthors(ctx);
  const ds = attendees.map((a) => a.d);
  const found: { id: string; created_at?: number; tags: string[][]; content: string }[] = [];
  for (let i = 0; i < ds.length; i += DIRECTORY_READ_CHUNK) {
    const chunk = ds.slice(i, i + DIRECTORY_READ_CHUNK);
    const events = await fetchEvents(
      { kinds: [KIND_DIRECTORY_ENTRY], authors, "#d": chunk },
      ctx.config.relays,
    );
    found.push(...(onlyByAuthors(onlyVerified(events), authors) as unknown as typeof found));
  }
  const byD = new Map<string, typeof found>();
  for (const e of found) {
    const d = e.tags.find((t) => t[0] === "d")?.[1];
    if (d) byD.set(d, [...(byD.get(d) ?? []), e]);
  }

  const eidPubkey = getPublicKey(eidSk);
  const roster: RosterContent = { v: 2, eck_current: newId, attendees: [] };
  const entries: VerifiedEvent[] = [];
  const grants: { to: string; wrap: unknown }[] = [];
  for (const a of attendees) {
    const latest = pickLatest(byD.get(a.d) ?? []);
    let content: unknown;
    if (latest) {
      const ref = readEckTag(latest.tags);
      const tryKeys = unionEck(ref ? eckCandidates(opts.held, ref) : [], [prevEck]);
      for (const k of tryKeys) {
        try {
          content = JSON.parse(eckDecrypt(base64ToBytes(k.key), latest.content));
          break;
        } catch {
          /* not this one */
        }
      }
    }
    const newD = blindedD(newEckBytes, ctx.coordinate, a.pubkey);
    roster.attendees.push({
      pubkey: a.pubkey,
      d: newD,
      role: a.role,
      ...(opts.keepChatKeys && a.chat_keys ? { chat_keys: a.chat_keys } : {}),
    });
    if (content) {
      entries.push(
        finalizeEvent(
          {
            kind: KIND_DIRECTORY_ENTRY,
            created_at: Math.floor(Date.now() / 1000),
            tags: [["d", newD], ["a", ctx.coordinate], ["eck", String(newId), eckFingerprint(newEckBytes)], ["v", "2"]],
            content: eckEncrypt(newEckBytes, JSON.stringify(content)),
          },
          eidSk,
        ),
      );
    }
    // Re-grant the new ECK set (all versions) — sealed by E_id so C2
    // authentication accepts it.
    grants.push({
      to: a.pubkey,
      wrap: wrapRumor(eidSk, a.pubkey, {
        kind: KIND_KEY_GRANT,
        content: {
          v: 2,
          a: ctx.coordinate,
          role: a.role,
          eck: eckAll,
          granted_by: eidPubkey,
          ...(await grantParentField(ctx, eidSk, a.pubkey)),
        },
      }),
    });
  }
  return { roster, entries, grants };
}

/** How many directory `d`s one REQ asks for when re-keying a roster. */
const DIRECTORY_READ_CHUNK = 100;

/** Publish what {@link rekeyRoster} built (plus any extra events) and wait for all of it. */
async function publishRekeyed(
  ctx: EventContext,
  extra: VerifiedEvent[],
  rekeyed: Rekeyed,
  rosterEvents: VerifiedEvent[],
): Promise<void> {
  await Promise.all([
    ...extra.map((e) => publishOrQueue(e, ctx.config.relays)),
    ...rekeyed.entries.map((e) => publishOrQueue(e, ctx.config.relays)),
    ...rekeyed.grants.map((g) => publishAccountGiftWrap(g.wrap as any, g.to, ctx.config.relays)),
    // No `previous` in rosterEvents: every entry's blinded `d` was re-derived
    // under the NEW ECK, so every page genuinely changed.
    ...rosterEvents.map((e) => publishOrQueue(e, ctx.config.relays)),
  ]);
}

/**
 * Rotate the ECK AND the E_inbox on a coordinator detach/replace (NIP §3.7). A
 * departing coordinator may retain the E_inbox + ECK it held, so both are rotated
 * to protect FUTURE content: mint a new ECK version and a fresh E_inbox keypair,
 * re-encrypt every attendee's directory entry + republish the roster under the new
 * ECK, and re-grant the new ECK to all approved attendees (no attendee removed).
 * The old E_inbox secret is retained locally (`priorEinboxNsecs`) so the organizer
 * can still read pre-rotation history; senders always encrypt to the newest config's
 * inbox, so the rotation is transparent to attendees. Forward-only, and honest about
 * it: ciphertext already published under the old key/inbox stays readable to whoever
 * held it. Returns the new inbox pubkey/secret + the full ECK set so the caller can
 * put them in the replacement 31600 / 21603.
 */
async function rotateEckAndInbox(
  organizer: AppSigner,
  ctx: EventContext,
  keys: EventKeys,
  blindingKey: Uint8Array | undefined,
  /** The identity whose custody `keys` is — written back under it explicitly (DS41-001). */
  owner: string | undefined,
): Promise<{ newInboxNsecHex: string; newInboxPubkey: string; eck: EckVersion[] }> {
  const eidSk = hexToBytes(keys.eidNsecHex!);
  if (!currentEck(keys)) throw new Error("no ECK available");

  // Read the roster FIRST. Everything below is driven by it: only the people it
  // lists get the new ECK, and the roster is republished as exactly that list. A
  // lost read therefore doesn't produce a smaller rotation, it produces a
  // coordinator swap that quietly locks the whole event out — nobody re-granted,
  // an empty roster published over the real one. Same class as the revoke path.
  // Read with every held version, keyed by the roster's own tag (DS41-002).
  const rosterRead = await loadRoster(ctx, keys, owner);
  const prevEck = (rosterRead.state === "ok" && rosterRead.eck) || currentEck(keys)!;

  // Mint the new ECK version and a fresh E_inbox keypair.
  const newEck = mintEck(keys);
  const newId = newEck.id;
  const newEckBytes = base64ToBytes(newEck.key);
  const eckAll = unionEck(keys.eck, [newEck]);
  const newInboxSk = generateSecretKey();
  const newInboxNsecHex = bytesToHex(newInboxSk);
  const newInboxPubkey = getPublicKey(newInboxSk);

  // Re-encrypt every attendee's directory entry under the new ECK (new blinded d),
  // republish the roster, and re-grant the new ECK set to each — no one removed.
  // Built first, published after the keys are saved (DS41-002): the new ECK must
  // never be on the relays without also being in this device's keystore, and
  // never current here while the slow per-attendee work is still pending.
  const { roster, at: rosterAt } = rosterForRewrite(rosterRead, prevEck.id);
  const rekeyed = await rekeyRoster(ctx, eidSk, prevEck, roster.attendees, newEckBytes, newId, eckAll, {
    keepChatKeys: true,
    held: unionEck(keys.eck, keys.pendingEck ?? []),
  });
  const rosterEvents = buildRosterEvents(ctx, eidSk, newEckBytes, newId, rekeyed.roster, rosterAt);

  // Persist: stage the new ECK (DS41-002: persisted before anything under it is
  // published, current only once it is), retain the old inbox secret for history
  // reading, and adopt the new inbox as primary.
  if (keys.einboxNsecHex) keys.priorEinboxNsecs = [...(keys.priorEinboxNsecs ?? []), keys.einboxNsecHex];
  keys.einboxNsecHex = newInboxNsecHex;
  await stageEck(keys, newEck, owner);
  await publishRekeyed(ctx, [], rekeyed, rosterEvents);
  await promotePending(keys, newEck, owner);
  // New inbox + new ECK: co-organizers must get both or go blind (SB-90).
  await reissueOrganizerGrants(organizer, ctx, keys);
  // Never silent (audit EV-11). The rotation has already happened locally; if the
  // backup does not publish, the durable record of the new ECK and the new inbox
  // simply is not there, and a later recovery on a fresh device restores an event
  // whose roster and directory it cannot read.
  if (blindingKey) {
    await writeEventKeysBackup(organizer, ctx.coordinate, keys, blindingKey, keys.coordinatorGen ?? 0, { owner }).catch(
      (e: unknown) => {
        console.warn("[organizer] ECK/inbox rotated but its backup did not publish:", e);
      },
    );
  }

  return { newInboxNsecHex, newInboxPubkey, eck: eckAll };
}

/**
 * Heal a same-id ECK collision (NIP §4.1, audit SB-86) by moving forward: mint
 * `max id + 1`, which is unique again, re-encrypt the roster and every directory
 * entry under it, and re-grant the FULL version list (both colliding keys
 * included) to everyone on the roster, so nothing already encrypted under either
 * key becomes unreadable to someone who held it. Same staging, backup and
 * co-organizer re-issue as any rotation.
 *
 * It re-grants everyone the live roster lists. When the collision came from two
 * concurrent REVOKES, the roster that lost the relay race is gone, and a person
 * only that device removed is on the surviving roster and keeps access: revoke
 * them again afterwards (Admin says so). With a coordinator attached the
 * coordinator owns rotation; this refuses, and detach + re-attach rotates.
 */
export async function repairEventKeys(
  organizer: AppSigner,
  ctx: EventContext,
  blindingKey?: Uint8Array,
): Promise<void> {
  const owner = activeKeystoreOwner() ?? undefined;
  const keys = await loadEventKeys(ctx.coordinate, owner);
  if (!keys || keys.role !== "organizer" || !keys.eidNsecHex) throw new Error("organizer keys not available");
  const cfg = await freshConfig(ctx);
  if (cfg.coordinator) throw new CoordinatorAttachedError();
  assertCurrentCustody(cfg, keys);
  ctx = { ...ctx, config: cfg };
  const eidSk = hexToBytes(keys.eidNsecHex);
  const rosterRead = await loadRoster(ctx, keys, owner);
  const prevEck = (rosterRead.state === "ok" && rosterRead.eck) || currentEck(keys)!;
  const { roster, at: rosterAt } = rosterForRewrite(rosterRead, prevEck.id);
  const newEck = mintEck(keys);
  const newEckBytes = base64ToBytes(newEck.key);
  const eckAll = unionEck(keys.eck, [newEck]);
  const rekeyed = await rekeyRoster(ctx, eidSk, prevEck, roster.attendees, newEckBytes, newEck.id, eckAll, {
    keepChatKeys: true,
    held: unionEck(keys.eck, keys.pendingEck ?? []),
  });
  const rosterEvents = buildRosterEvents(ctx, eidSk, newEckBytes, newEck.id, rekeyed.roster, rosterAt);
  await stageEck(keys, newEck, owner);
  if (blindingKey) {
    await writeEventKeysBackup(organizer, ctx.coordinate, keys, blindingKey, keys.coordinatorGen ?? 0, { owner, configInbox: cfg.inbox }).catch(
      (e: unknown) => console.warn("[organizer] keys repaired but the backup did not publish:", e),
    );
  }
  await publishRekeyed(ctx, [], rekeyed, rosterEvents);
  await promotePending(keys, newEck, owner);
  await reissueOrganizerGrants(organizer, ctx, keys);
}

/**
 * Attach a coordinator to the event (spec §8): republish the 31600 config with a
 * `coordinator` tag (signed by E_id) and gift-wrap a Coordinator Grant (21603)
 * carrying the E_inbox secret + ECK so it can read submissions. Installation is
 * protocol-level — no per-event server config.
 *
 * The grant is sealed by E_id (like 21604 admin commands): the coordinator
 * authenticates the install by matching the seal author against the coordinate's
 * E_id pubkey (spec §7.2, ENCRYPTION-AND-PRIVACY.md F2).
 */
const CONFIG_UNREADABLE =
  "Couldn't read this event's current settings from its relays, so nothing was published. " +
  "Publishing from this page's copy could undo changes made elsewhere. " +
  "Check your connection and try again.";

/**
 * The newest 31600 on the relays, which every config write must build on.
 *
 * Config writes republish the WHOLE 31600, and they used to build it from the
 * page's `ctx.config` — whatever the page read when it loaded, possibly hours
 * ago, on another device. Saving one field from a stale Settings page therefore
 * reverted every other field changed since (retention, relays, approval…), and
 * worst of all dropped a coordinator another device had attached: a 31600 that
 * no longer names the coordinator is a durable detach on the daemon side (audit
 * SB-02, SB-87). The earlier `withFreshLinks` fixed this for `parent`/`children`
 * only; this replaces it.
 *
 * Throws rather than falling back to `ctx.config`: a write built on a config we
 * could not read is exactly the write that destroys something.
 */
async function freshConfig(ctx: EventContext): Promise<EventConfig> {
  const read = await fetchNewestSignedConfig(ctx.coordinate, ctx.config.relays, { fresh: true }).catch(
    () => undefined,
  );
  if (!read) throw new Error(CONFIG_UNREADABLE);
  // Newest on THESE relays is not newest: one that missed a detach answers with
  // the config from before it (audit R-29). Not noted for the SB-91 guard either.
  assertConfigNotStale(ctx.coordinate, read.createdAt, ctx.configAt);
  noteFreshConfig(ctx.coordinate, read.config);
  return read.config;
}

// ── One roster authority (audit SB-91) ───────────────────────────────────────
//
// The 31604 address is written by the coordinator when one is attached and by
// E_id otherwise, and the choice of path used to come from the page's cached
// config: a page loaded before another device attached a coordinator kept
// approving locally, publishing an E_id roster that attendees picked over the
// coordinator's (newer created_at) until the coordinator's next publish dropped
// the person again. Admin now reads the newest 31600 on every refresh and notes
// it here; the local approve/revoke paths refuse while it names a coordinator.

/** How long a noted fresh config stands in for a new read in the guards below. */
const FRESH_CONFIG_TTL_MS = 90_000;
const freshConfigMemo = new Map<string, { cfg: EventConfig; at: number }>();

/** Record the newest 31600 read from the relays (Admin's refresh, every config write). */
export function noteFreshConfig(coordinate: string, cfg: EventConfig): void {
  freshConfigMemo.set(coordinate, { cfg, at: Date.now() });
}

/** Test-only. */
export function __resetFreshConfigMemoForTests(): void {
  freshConfigMemo.clear();
}

/** A coordinator is attached: the roster is its to write, route through a 21604. */
export class CoordinatorAttachedError extends Error {
  constructor() {
    super(
      "A coordinator is attached to this event, so approvals and removals go through it. " +
        "Refresh this page and try again.",
    );
    this.name = "CoordinatorAttachedError";
  }
}

/**
 * Refuse a client-authored 31604 when the event's newest config names a
 * coordinator. Uses the config Admin noted within the last 90 s, else reads one.
 * A read that fails falls back to the page's config: the guard exists to stop a
 * KNOWN second authority, and refusing every approval on a flaky read would make
 * a coordinator-less event unmanageable offline.
 */
async function assertNoCoordinatorAuthority(ctx: EventContext): Promise<void> {
  if (ctx.config.coordinator) throw new CoordinatorAttachedError();
  let memo = freshConfigMemo.get(ctx.coordinate);
  if (!memo || Date.now() - memo.at > FRESH_CONFIG_TTL_MS) {
    const cfg = await fetchNewestConfig(ctx.coordinate, ctx.config.relays, { fresh: true }).catch(() => undefined);
    if (cfg) noteFreshConfig(ctx.coordinate, cfg);
    memo = freshConfigMemo.get(ctx.coordinate);
  }
  if (memo?.cfg.coordinator) throw new CoordinatorAttachedError();
}

/**
 * Refuse to rotate or hand out keys this device no longer holds the current
 * version of. Another organizer device (or a co-organizer) that rotated the
 * E_inbox/ECK on attach/detach published the new inbox and `eck` on the 31600;
 * a device still on the old ones would grant the coordinator a dead inbox secret
 * and mint a colliding ECK version (audit SB-90, SB-86). Fail loudly instead.
 */
function assertCurrentCustody(cfg: EventConfig, keys: EventKeys): void {
  if (custodyIsStale(cfg, keys)) throw new KeysChangedElsewhereError();
}

/** The newest 31600 names an inbox, or an ECK version, this device does not hold. */
function custodyIsStale(cfg: EventConfig, keys: EventKeys): boolean {
  // Current OR prior inbox: a device whose own rotation got as far as saving the
  // new inbox but not as far as the 31600 is ahead of the config, not behind it.
  const heldInboxes = [keys.einboxNsecHex, ...(keys.priorEinboxNsecs ?? [])]
    .filter((h): h is string => !!h)
    .map((h) => getPublicKey(hexToBytes(h)));
  // Staged versions count: this device minted them, it is ahead, not behind.
  const heldEck = unionEck(keys.eck, keys.pendingEck ?? []).reduce((m, v) => Math.max(m, v.id), 0);
  return (heldInboxes.length > 0 && !heldInboxes.includes(cfg.inbox)) || cfg.eck > heldEck;
}

/** What Admin shows about this device's custody (audit SB-90, SB-86, SB-91). */
export interface OrganizerKeyStatus {
  /** The newest 31600 on the relays (Admin adopts it, so routing is fresh). */
  config: EventConfig;
  /** The config names an inbox or ECK version this device does not hold. */
  changedElsewhere: boolean;
  /** Two keys share the current ECK id (an unhealed concurrent rotation). */
  collision: boolean;
}

/**
 * Admin's per-refresh custody check. Reads the newest 31600 (one relay read, no
 * signer), notes it for the SB-91 guard, makes the inbox it names current when
 * this device holds it as a retired one, and reports whether this device is
 * behind (SB-90) or holds a same-id collision (SB-86).
 *
 * With `reconcile` (once per Admin open, never on the 30 s poll: it costs a signer
 * decrypt, and on a remote signer that is a prompt) it also folds the account's
 * 30078 backup into this device, which is how a second device of the SAME account
 * learns about a rotation the first one made, and republishes the union when this
 * device holds something the backup lacks. Undefined when the config is unreadable.
 */
export async function checkOrganizerKeys(
  ctx: EventContext,
  opts: { organizer?: AppSigner | null; blindingKey?: Uint8Array; reconcile?: boolean } = {},
): Promise<OrganizerKeyStatus | undefined> {
  const owner = activeKeystoreOwner() ?? undefined;
  const cfg = await fetchNewestConfig(ctx.coordinate, ctx.config.relays, { fresh: true }).catch(() => undefined);
  if (!cfg) return undefined;
  noteFreshConfig(ctx.coordinate, cfg);
  let keys = await loadEventKeys(ctx.coordinate, owner);
  if (!keys || keys.role !== "organizer") return { config: cfg, changedElsewhere: false, collision: false };
  if (opts.reconcile && opts.organizer && opts.blindingKey && keys.eidNsecHex && keys.einboxNsecHex) {
    try {
      await reconcileEventKeysBackup(opts.organizer, ctx.coordinate, keys, opts.blindingKey, cfg.inbox, owner);
    } catch (e) {
      console.warn("[organizer] could not reconcile the event-keys backup:", e);
    }
  }
  await adoptConfigInbox(ctx.coordinate, cfg.inbox, (s) => getPublicKey(hexToBytes(s)), owner).catch(() => false);
  keys = (await loadEventKeys(ctx.coordinate, owner)) ?? keys;
  const cur = currentEck(keys);
  return {
    config: cfg,
    changedElsewhere: custodyIsStale(cfg, keys),
    collision: !!cur && eckCollisionIds(keys.eck).includes(cur.id),
  };
}

/**
 * Fold the account's backup into this device and, when this device holds custody
 * the backup lacks, publish the union (SB-89/SB-90). One decrypt per changed
 * backup event per session; one encrypt + signature only when there is something
 * to add.
 */
async function reconcileEventKeysBackup(
  organizer: AppSigner,
  coordinate: string,
  keys: EventKeys,
  blindingKey: Uint8Array,
  configInbox: string,
  owner: string | undefined,
): Promise<void> {
  const ownPubkey = await organizer.getPublicKey();
  const d = eventKeysBackupD(blindingKey, coordinate, ownPubkey);
  const local = keysAsBackup(keys, coordinate, keys.coordinatorGen ?? 0);
  const remote = await readEventKeysBackup(organizer, ownPubkey, d);
  if (remote) {
    const merged = mergeEventKeysBackups(local, remote.backup, { configInbox });
    if (foldBackupIntoKeys(keys, merged)) await saveEventKeys(keys, owner);
    if (sameBackup(merged, remote.backup)) return;
  }
  await writeEventKeysBackup(organizer, coordinate, keys, blindingKey, keys.coordinatorGen ?? 0, { owner, configInbox });
}

/** Same custody, ignoring field order and list order. */
function sameBackup(a: EventKeysBackup, b: EventKeysBackup): boolean {
  const norm = (x: EventKeysBackup) =>
    JSON.stringify({
      eck: unionEck(x.eck).map((v) => `${v.id}|${v.key}`),
      pending: unionEck(x.pending_eck ?? []).map((v) => `${v.id}|${v.key}`),
      inbox: x.einbox_nsec,
      prior: [...(x.prior_einbox_nsecs ?? [])].sort(),
      gen: x.coordinator_gen ?? 0,
      co: [...(x.co_organizers ?? [])].sort(),
    });
  return norm(a) === norm(b);
}

/**
 * Republish the event's 31600 config with changed fields (signed by E_id). Used by
 * Admin to flip live-editable settings like the prerecorded-talks mode (spec F2).
 * Every other field is preserved from the NEWEST config on the relays (see
 * {@link freshConfig}), and the config as published is returned so the caller
 * can adopt it.
 */
export async function updateEventConfig(
  ctx: EventContext,
  changes: Partial<{
    talks: TalksMode;
    maxTalkSec: number;
    chat: ChatBackend[];
    retentionDays: number | undefined;
    relays: string[];
  }>,
): Promise<EventConfig> {
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys || keys.role !== "organizer" || !keys.eidNsecHex) {
    throw new Error("organizer E_id key not available");
  }
  const eidSk = hexToBytes(keys.eidNsecHex);
  if (changes.relays && unionRelays(changes.relays).length === 0) {
    throw new Error("at least one relay is required");
  }
  const current = await freshConfig(ctx);
  // Relay list. An admin can rewrite it explicitly (Settings → Relays); otherwise
  // the event keeps the relays it was published with. We NEVER silently migrate a
  // live event onto changed app defaults — only newly created events pick those up
  // (create.ts).
  const chatActive = (changes.chat ?? current.chat).length > 0;
  const relays = changes.relays ? unionRelays(changes.relays) : current.relays;
  // Chat relays are a SEPARATE set (`chat_relay` tags) and are never folded into
  // the list above: the Whitenoise interop pair refuses every kind we publish
  // except the chat ones, so having them in `relays` — as this did until
  // 2026-07-28 — meant this very republish drew a "blocked: kind 31600 is not
  // accepted by this relay" from two of the event's own relays.
  //
  // Whether chat is being turned on now or is already active, ensure the interop
  // pair is present (same as at-creation) so a manual relay edit cannot drop what
  // Marmot routing depends on. Turning chat OFF leaves the set as-is rather than
  // clearing it: the group may still exist and be draining, and a re-enable must
  // not have to rediscover the relays it was routing over.
  const chatRelays = chatActive
    ? unionRelays(chatRelaysOf(current), chatInteropRelays(relays))
    : chatRelaysOf(current);
  const next: EventConfig = { ...current, ...changes, relays, chatRelays };
  const built = buildEventConfig(configForSpace(next, ctx.coordinate));
  // Monotonic republish (audit P3): a config change made in the same second as
  // the previous 31600 must win the §3.1 tie-break, or the stale config stays
  // authoritative and the setting silently doesn't take. Read + publish across the
  // OLD and NEW relay sets together: the current version may live only on the old
  // relays (so the tie-break must see it), and the update must reach both the
  // relays existing subscribers watch and any newly added ones.
  await publishMonotonic({
    kind: built.kind,
    author: current.eidPubkey,
    identifier: current.d,
    relays: unionRelays(ctx.config.relays, current.relays, relays),
    sign: (created_at) =>
      finalizeEvent(
        { kind: built.kind, created_at, tags: built.tags, content: built.content },
        eidSk,
      ),
  });
  return next;
}

export async function attachCoordinator(
  organizer: AppSigner,
  ctx: EventContext,
  coordinatorPubkey: string,
  blindingKey?: Uint8Array,
): Promise<void> {
  // Captured once (audit DS41-001): the write-backs below happen after several
  // relay round trips, and must land under the identity that read these keys.
  const owner = activeKeystoreOwner() ?? undefined;
  const keys = await loadEventKeys(ctx.coordinate, owner);
  if (!keys || keys.role !== "organizer" || !keys.eidNsecHex || !keys.einboxNsecHex) {
    throw new Error("organizer keys not available on this device");
  }
  const eidSk = hexToBytes(keys.eidNsecHex);
  // Build on the newest 31600, not the page's copy (SB-02/SB-87): `previous`
  // below decides whether this is a replacement (detach + rotate), and a stale
  // page that had not seen another device's attach skipped both.
  const current = await freshConfig(ctx);
  assertCurrentCustody(current, keys);
  ctx = { ...ctx, config: current };

  // Install generation (NIP §3.5): strictly increase across every attach/detach/
  // re-attach so a replayed historical 21603 can never re-install. The last-used
  // gen lives on the local record + the 30078 backup, and is also on the wire in
  // the newest 31600: take the highest, so a second device that attached since
  // this one last did cannot make it reuse a generation (SB-89b).
  const gen = Math.max(keys.coordinatorGen ?? 0, current.coordinatorGen ?? 0) + 1;

  // 0. Coordinator replacement: if a DIFFERENT coordinator is currently attached,
  //    detach it first (signed 21604) so it disposes of custody promptly, then rotate
  //    the ECK + E_inbox (NIP §3.7) — the departing coordinator may retain the keys it
  //    held, so both are rotated to protect future content. The new grant + config
  //    below carry the rotated inbox + ECK. A FRESH attach (no prior coordinator, or
  //    re-attaching the same one) does not rotate — there is no departing custodian.
  const previous = ctx.config.coordinator;
  const replacing = !!previous && previous !== coordinatorPubkey;
  let einboxNsecHex = keys.einboxNsecHex;
  let einboxPubkey = ctx.config.inbox;
  let eck = keys.eck;
  if (replacing) {
    const expires = Math.floor(Date.now() / 1000) + ADMIN_COMMAND_TTL_SEC;
    const detachWrap = wrapRumor(eidSk, previous!, {
      kind: KIND_ADMIN_COMMAND,
      content: { v: 2, a: ctx.coordinate, cmd: "detach", args: {}, expires },
    });
    await publishAccountGiftWrap(detachWrap as any, previous!, ctx.config.relays);
    const rotated = await rotateEckAndInbox(organizer, ctx, keys, blindingKey, owner);
    einboxNsecHex = rotated.newInboxNsecHex;
    einboxPubkey = rotated.newInboxPubkey;
    eck = rotated.eck;
  }

  // 1. Republish 31600 with the three-element coordinator tag (signed by E_id),
  //    advertising the (possibly rotated) inbox. The `eck` tag is bootstrap-only
  //    and grants/roster are the current-ECK authority (audit P5) — but on a
  //    replace we DID just rotate the ECK, so write the fresh version onto the
  //    config we sign rather than leaving a stale bootstrap value. Nothing reads
  //    this as "current"; it just keeps the signed config from actively lying.
  const currentEckId = eck.reduce((m, v) => Math.max(m, v.id), ctx.config.eck);
  const cfg = {
    ...ctx.config,
    inbox: einboxPubkey,
    coordinator: coordinatorPubkey,
    coordinatorGen: gen,
    eck: currentEckId,
  };
  const built = buildEventConfig(configForSpace(cfg, ctx.coordinate));

  // 2. Gift-wrap the Coordinator Grant (21603) carrying the same gen, sealed by
  //    E_id so the coordinator can authenticate the install against the coordinate.
  const grantWrap = wrapRumor(eidSk, coordinatorPubkey, {
    kind: KIND_COORDINATOR_GRANT,
    content: {
      v: 2,
      a: ctx.coordinate,
      gen,
      // On a replace, the rotated inbox secret + full ECK (incl. the new version).
      inbox_nsec: einboxNsecHex,
      eck,
      config_relays: ctx.config.relays,
      // The coordinator this one takes over from (NIP §3.7, audit SB-122). The
      // new coordinator adopts a roster only from E_id or from the coordinator
      // named here, so naming it is what lets the outgoing coordinator's approvals
      // carry over; a forged roster under any other key is ignored.
      ...(replacing ? { prev_coordinator: previous } : {}),
    },
  });

  // Monotonic config republish (audit P3): an attach in the same second as the
  // prior config must win the §3.1 tie-break, or the grant can be published while
  // the coordinator-bearing config never becomes current.
  await Promise.all([
    publishMonotonic({
      kind: built.kind,
      author: ctx.config.eidPubkey,
      identifier: ctx.config.d,
      relays: ctx.config.relays,
      sign: (created_at) =>
        finalizeEvent(
          { kind: built.kind, created_at, tags: built.tags, content: built.content },
          eidSk,
        ),
    }),
    publishAccountGiftWrap(grantWrap as any, coordinatorPubkey, ctx.config.relays),
  ]);

  // 3. Persist the new gen locally and (durably) in the 30078 backup so a re-attach
  //    — on this or a fresh device — increments past it instead of colliding.
  await saveEventKeys({ ...keys, coordinatorGen: gen }, owner);
  if (blindingKey) {
    // Never silent (audit EV-11): without this backup the last-used coordinator
    // generation is not durable, and the next attach reuses a colliding gen that
    // the coordinator refuses.
    await writeEventKeysBackup(organizer, ctx.coordinate, keys, blindingKey, gen, { owner }).catch((e: unknown) => {
      console.warn("[organizer] attach recorded gen", gen, "but its backup did not publish:", e);
    });
  }
}

/** This device's custody for one event, in the 30078 backup's shape. */
function keysAsBackup(keys: EventKeys, coordinate: string, coordinatorGen: number): EventKeysBackup {
  return {
    v: 2,
    a: coordinate,
    eid_nsec: keys.eidNsecHex!,
    einbox_nsec: keys.einboxNsecHex!,
    eck: keys.eck,
    coordinator_gen: Math.max(coordinatorGen, keys.coordinatorGen ?? 0),
    ...(keys.pendingEck?.length ? { pending_eck: keys.pendingEck } : {}),
    ...(keys.priorEinboxNsecs?.length ? { prior_einbox_nsecs: keys.priorEinboxNsecs.slice(-MAX_PRIOR_INBOXES) } : {}),
    ...(keys.coOrganizers?.length ? { co_organizers: keys.coOrganizers.slice(0, MAX_ORGANIZERS) } : {}),
  };
}

/**
 * Fold a merged backup into the local record (mutates `keys`). Returns whether
 * anything changed, i.e. whether the other copy held custody this device lacked.
 */
function foldBackupIntoKeys(keys: EventKeys, merged: EventKeysBackup): boolean {
  const snap = () => JSON.stringify([keys.eck, keys.pendingEck ?? [], keys.einboxNsecHex, keys.priorEinboxNsecs ?? [], keys.coordinatorGen ?? 0, keys.coOrganizers ?? []]);
  const before = snap();
  keys.eck = unionEck(keys.eck, merged.eck);
  const pending = unionEck(keys.pendingEck ?? [], merged.pending_eck ?? []).filter(
    (p) => !keys.eck.some((v) => v.id === p.id && v.key === p.key),
  );
  keys.pendingEck = pending.length > 0 ? pending : undefined;
  const inboxes = [...new Set([keys.einboxNsecHex, merged.einbox_nsec, ...(keys.priorEinboxNsecs ?? []), ...(merged.prior_einbox_nsecs ?? [])])].filter(
    (s): s is string => !!s,
  );
  keys.einboxNsecHex = merged.einbox_nsec;
  const prior = inboxes.filter((s) => s !== merged.einbox_nsec);
  keys.priorEinboxNsecs = prior.length > 0 ? prior : undefined;
  keys.coordinatorGen = Math.max(keys.coordinatorGen ?? 0, merged.coordinator_gen ?? 0) || undefined;
  const co = [...new Set([...(keys.coOrganizers ?? []), ...(merged.co_organizers ?? [])])];
  keys.coOrganizers = co.length > 0 ? co : undefined;
  return before !== snap();
}

/** Thrown when the account's backup exists but cannot be read, so it is not rewritten blind. */
export class EventKeysBackupUnreadableError extends Error {
  constructor() {
    super("Couldn't read this event's key backup, so it was not rewritten (that would drop keys saved by your other devices).");
    this.name = "EventKeysBackupUnreadableError";
  }
}

function eventKeysBackupD(blindingKey: Uint8Array, coordinate: string, ownPubkey: string): string {
  return `nostrautica:eventkeys:${blindedD(blindingKey, coordinate, ownPubkey)}`;
}

/**
 * The account's current backup for this event from the relays, decrypted.
 * Undefined when there is none (or no relay answered); throws
 * {@link EventKeysBackupUnreadableError} when one exists but will not decrypt or parse.
 */
async function readEventKeysBackup(organizer: AppSigner, ownPubkey: string, d: string): Promise<{ backup: EventKeysBackup; id: string } | undefined> {
  const events = await fetchEventsRelayOnly({ kinds: [KIND_APP_DATA], authors: [ownPubkey], "#d": [d] }).catch(() => []);
  const latest = pickLatest(
    onlyByAuthors(onlyVerified(events), [ownPubkey]).filter((e) => e.tags?.some((t) => t[0] === "d" && t[1] === d)),
  );
  if (!latest) return undefined;
  // One decrypt per backup EVENT per session: a 30078 rewrite is a new id, so this
  // can never serve a stale copy, and on a remote signer each decrypt is a prompt.
  const hit = decryptedBackups.get(d);
  if (hit && hit.id === latest.id) return hit;
  try {
    const json = await organizer.nip44Decrypt(ownPubkey, latest.content);
    const read = { backup: eventKeysBackupSchema.parse(JSON.parse(json)), id: latest.id! };
    decryptedBackups.set(d, read);
    return read;
  } catch {
    throw new EventKeysBackupUnreadableError();
  }
}

const decryptedBackups = new Map<string, { backup: EventKeysBackup; id: string }>();

/**
 * Republish the organizer's self-encrypted 30078 event-keys backup (with the given
 * coordinator generation, NIP §3.5) as a READ-MERGE-WRITE (audit SB-89).
 *
 * Every device of the account writes the same address. Publishing this device's
 * snapshot replaced whatever another device had backed up: its ECK version, its
 * rotated inbox, its higher install generation, all gone from the only durable
 * copy. So the current backup is read first and the union published
 * (`mergeEventKeysBackups`), and anything the other copy held that this device
 * lacked is folded into the local record too. A backup that exists but cannot be
 * read is not overwritten (the caller warns; the next write or Admin's
 * reconcile retries). `configInbox` (the inbox the newest 31600 names) decides
 * which E_inbox is current when the two copies disagree.
 */
async function writeEventKeysBackup(
  organizer: AppSigner,
  coordinate: string,
  keys: EventKeys,
  blindingKey: Uint8Array,
  coordinatorGen: number,
  opts: { owner?: string; configInbox?: string } = {},
): Promise<void> {
  if (!keys.eidNsecHex || !keys.einboxNsecHex) return;
  const ownPubkey = await organizer.getPublicKey();
  const d = eventKeysBackupD(blindingKey, coordinate, ownPubkey);
  await withMutationLock(`rmw:${ownPubkey}:${KIND_APP_DATA}:${d}`, async () => {
    const local = keysAsBackup(keys, coordinate, coordinatorGen);
    const remote = await readEventKeysBackup(organizer, ownPubkey, d);
    const backup = remote ? mergeEventKeysBackups(local, remote.backup, { configInbox: opts.configInbox }) : local;
    if (remote && foldBackupIntoKeys(keys, backup)) await saveEventKeys(keys, opts.owner);
    const content = await organizer.nip44Encrypt(ownPubkey, JSON.stringify(backup));
    // Monotonic republish (audit P3): the 30078 backup is rewritten on every
    // attach/detach/rotation. Two rotations in the same second must not let the
    // §3.1 tie-break resurrect the older backup (stale coordinator gen / ECK set).
    await publishMonotonic({
      kind: KIND_APP_DATA,
      author: ownPubkey,
      identifier: d,
      owner: ownPubkey,
      sign: (created_at) =>
        organizer.signEvent({
          kind: KIND_APP_DATA,
          created_at,
          tags: [["d", d]],
          content,
        }) as Promise<VerifiedEvent>,
    });
  });
}

/**
 * Detach the currently-attached coordinator (NIP §3.5): republish the 31600 WITHOUT
 * a coordinator tag (signed by E_id) and send a signed 21604 `detach` command so the
 * coordinator durably tombstones the install and disposes of key custody (decision
 * D6). The last-used generation is retained locally, so a later re-attach increments
 * past it. No-op when no coordinator is attached.
 */
export async function detachCoordinator(
  organizer: AppSigner,
  ctx: EventContext,
  blindingKey?: Uint8Array,
): Promise<void> {
  if (!ctx.config.coordinator) return;
  const owner = activeKeystoreOwner() ?? undefined; // see attachCoordinator (DS41-001)
  const keys = await loadEventKeys(ctx.coordinate, owner);
  if (!keys || keys.role !== "organizer" || !keys.eidNsecHex) {
    throw new Error("organizer E_id key not available");
  }
  const eidSk = hexToBytes(keys.eidNsecHex);
  // The coordinator to detach, and every field republished below, come from the
  // newest 31600 rather than the page's copy (SB-02/SB-87). If another device
  // already detached it there is nothing left to do; if it attached a different
  // one, that is the one actually holding custody.
  const current = await freshConfig(ctx);
  const previous = current.coordinator;
  if (!previous) return;
  assertCurrentCustody(current, keys);
  ctx = { ...ctx, config: current };

  // 1. Signed 21604 detach to the current coordinator (immediate custody disposal),
  //    sent up front so the departing coordinator stops serving promptly.
  const expires = Math.floor(Date.now() / 1000) + ADMIN_COMMAND_TTL_SEC;
  const detachWrap = wrapRumor(eidSk, previous, {
    kind: KIND_ADMIN_COMMAND,
    content: { v: 2, a: ctx.coordinate, cmd: "detach", args: {}, expires },
  });
  await publishAccountGiftWrap(detachWrap as any, previous, ctx.config.relays);

  // 2. Rotate the ECK + E_inbox (NIP §3.7): a departed coordinator may retain the
  //    keys it held, so both are rotated (re-encrypt directory/roster, re-grant to
  //    all attendees) to protect future content. Reads the CURRENT (still
  //    coordinator-authored) records, so it must run before the new config publishes.
  const { newInboxPubkey, eck: rotatedEck } = await rotateEckAndInbox(organizer, ctx, keys, blindingKey, owner);

  // 3. Republish 31600 without the coordinator tag, advertising the NEW inbox so
  //    senders encrypt future submissions to the rotated inbox the organizer holds.
  //    Advance the bootstrap-only `eck` tag to the freshly rotated version (audit
  //    P5: grants/roster remain the authority, this just keeps the signed config
  //    from carrying a stale version).
  const { coordinator: _c, coordinatorGen: _g, ...rest } = ctx.config;
  void _c;
  void _g;
  const currentEckId = rotatedEck.reduce((m, v) => Math.max(m, v.id), ctx.config.eck);
  const built = buildEventConfig(configForSpace({ ...rest, inbox: newInboxPubkey, eck: currentEckId }, ctx.coordinate));
  // Monotonic republish (audit P3): a detach in the same second as the previous
  // config must win the §3.1 tie-break, or the coordinator-bearing config can
  // stay authoritative and the detach silently doesn't take.
  await publishMonotonic({
    kind: built.kind,
    author: ctx.config.eidPubkey,
    identifier: ctx.config.d,
    relays: ctx.config.relays,
    sign: (created_at) =>
      finalizeEvent(
        { kind: built.kind, created_at, tags: built.tags, content: built.content },
        eidSk,
      ),
  });
}
