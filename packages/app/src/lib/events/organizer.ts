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
  KIND_GIFT_WRAP,
  KIND_JOIN_REQUEST,
  KIND_PROFILE_SUBMISSION,
  KIND_KEY_GRANT,
  KIND_DIRECTORY_ENTRY,
  KIND_ROSTER,
  KIND_MATCH_LIST,
  KIND_MATCH_MATRIX,
  KIND_DELETION,
  giftwrapSince,
  unwrapRumor,
  eckEncrypt,
  eckDecrypt,
  generateEck,
  base64ToBytes,
  bytesToBase64,
  hexToBytes,
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
  KIND_COORDINATOR_GRANT,
  KIND_ADMIN_COMMAND,
  KIND_ORGANIZER_GRANT,
  type InviteProof,
  type AttendeeProfile,
  type MediaDescriptor,
  type EckVersion,
  type RosterContent,
} from "@nostrautica/protocol";
import type { GiftWrap } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "./event-context.js";
import type { EventKeys } from "./keystore.js";
import { loadEventKeys, currentEck, saveEventKeys } from "./keystore.js";
import { fetchEvents, fetchEventsRelayOnly } from "$lib/nostr/ndk.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

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
  rumorCreatedAt: number;
}

/** The publisher pubkey for directory/roster: coordinator if set, else E_id. */
export function directoryPublisher(ctx: EventContext): string {
  return ctx.config.coordinator ?? ctx.config.eidPubkey;
}

/**
 * Fetch and unwrap all inbound gift wraps to E_inbox, collapsing to the latest
 * join request + submission per attendee (latest by rumor created_at wins).
 */
export async function fetchPending(
  ctx: EventContext,
  keys: EventKeys,
): Promise<PendingRequest[]> {
  if (!keys.einboxNsecHex) throw new Error("missing E_inbox key");
  const einboxSk = hexToBytes(keys.einboxNsecHex);
  // Relay-only: join requests must not be lost to the cache/EOSE race (see ndk.ts).
  const wraps = (await fetchEventsRelayOnly(
    { kinds: [KIND_GIFT_WRAP], "#p": [getPublicKey(einboxSk)], since: giftwrapSince() },
    ctx.config.relays,
  )) as unknown as GiftWrap[];

  const byAttendee = new Map<string, PendingRequest>();
  const submissions = new Map<
    string,
    { at: number; profile: AttendeeProfile; media: MediaDescriptor[]; introText?: string }
  >();

  for (const wrap of wraps) {
    let rumor;
    try {
      rumor = unwrapRumor(wrap, einboxSk);
    } catch {
      continue; // not ours / malformed
    }
    if (rumor.kind === KIND_JOIN_REQUEST) {
      let content;
      try {
        content = joinRequestContentSchema.parse(JSON.parse(rumor.content));
      } catch {
        continue;
      }
      const invite = parseInviteTag(rumor.tags);
      const prev = byAttendee.get(rumor.pubkey);
      if (!prev || rumor.created_at > prev.rumorCreatedAt) {
        byAttendee.set(rumor.pubkey, {
          attendeePubkey: rumor.pubkey,
          name: content.name,
          message: content.message,
          rsvpPublic: content.rsvp_public,
          invite,
          rumorCreatedAt: rumor.created_at,
        });
      }
    } else if (rumor.kind === KIND_PROFILE_SUBMISSION) {
      try {
        const parsed = profileSubmissionContentSchema.parse(JSON.parse(rumor.content));
        const prev = submissions.get(rumor.pubkey);
        if (!prev || rumor.created_at > prev.at) {
          submissions.set(rumor.pubkey, {
            at: rumor.created_at,
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

  // Fold submissions into their requests.
  for (const [pubkey, sub] of submissions) {
    const req = byAttendee.get(pubkey);
    if (req) {
      req.profile = sub.profile;
      req.media = sub.media;
      req.introText = sub.introText;
    }
  }
  const result = [...byAttendee.values()].sort((a, b) => a.rumorCreatedAt - b.rumorCreatedAt);
  const newestAt = result.reduce((m, r) => Math.max(m, r.rumorCreatedAt), 0);
  cacheSet(pendingKey(ctx.coordinate), result, newestAt);
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
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys || keys.role !== "organizer") throw new Error("not the organizer");
  const eck = currentEck(keys);
  if (!eck) throw new Error("no ECK available");
  if (!keys.eidNsecHex) throw new Error("missing E_id key");
  const eidSk = hexToBytes(keys.eidNsecHex);
  const eckBytes = base64ToBytes(eck.key);

  // 1. Key grant (21602) → attendee, sealed by E_id — the grant comes from the
  // event authority, and the attendee's C2 authentication requires the seal author
  // to be E_id (or the coordinator). Sealing with the organizer's personal key
  // would be rejected as forged (the no-coordinator approval path).
  const grant = {
    v: 1,
    a: ctx.coordinate,
    role,
    eck: keys.eck,
    granted_by: getPublicKey(eidSk),
  };
  const grantWrap = wrapRumor(eidSk, req.attendeePubkey, {
    kind: KIND_KEY_GRANT,
    content: grant,
  });

  // 2. Directory entry (31603) under ECK, blinded d over ECK, signed by E_id.
  const entryD = blindedD(eckBytes, ctx.coordinate, req.attendeePubkey);
  const entryContent = {
    v: 1,
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
        ["eck", String(eck.id)],
        ["v", "1"],
      ],
      content: eckEncrypt(eckBytes, JSON.stringify(entryContent)),
    },
    eidSk,
  );

  // 3. Roster (31604): add this attendee, republish the whole index.
  const roster = await loadRoster(ctx, eckBytes, keys.eck);
  if (!roster.attendees.some((a) => a.pubkey === req.attendeePubkey)) {
    roster.attendees.push({ pubkey: req.attendeePubkey, d: entryD, role });
  }
  const rosterEvent = buildRosterEvent(ctx, eidSk, eckBytes, eck.id, roster);

  await Promise.all([
    publishOrQueue(grantWrap as any, ctx.config.relays),
    publishOrQueue(entryEvent, ctx.config.relays),
    publishOrQueue(rosterEvent, ctx.config.relays),
  ]);
}

/**
 * Fetch + decrypt the current roster (or an empty one if none exists yet).
 * This gates a read-modify-write republish (approveAttendee/revoke): it MUST
 * see the latest roster, including one this same client just published a
 * moment ago in a prior loop iteration (e.g. "Approve all"), or the republish
 * silently drops whoever was added last. `fetchEvents` goes through NDK's
 * cache-adapter-integrated subscription, which can resolve on EOSE before a
 * just-published/just-arrived event is surfaced (same hazard documented on
 * `fetchEventsRelayOnly` in ndk.ts) — use the relay-only variant here, same as
 * the other must-not-miss reads (grants, pending queue) already do.
 */
export async function loadRoster(
  ctx: EventContext,
  eckBytes: Uint8Array,
  eckVersions: EckVersion[],
): Promise<RosterContent> {
  const publisher = directoryPublisher(ctx);
  const { identifier } = splitCoordinate(ctx.coordinate);
  const events = await fetchEventsRelayOnly(
    { kinds: [KIND_ROSTER], authors: [publisher], "#d": [identifier] },
    ctx.config.relays,
  );
  const latest = events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  const currentId = eckVersions.reduce((m, v) => Math.max(m, v.id), 1);
  if (!latest) return { v: 1, eck_current: currentId, attendees: [] };
  try {
    const { eckDecrypt } = await import("@nostrautica/protocol");
    return JSON.parse(eckDecrypt(eckBytes, latest.content)) as RosterContent;
  } catch {
    return { v: 1, eck_current: currentId, attendees: [] };
  }
}

function buildRosterEvent(
  ctx: EventContext,
  eidSk: Uint8Array,
  eckBytes: Uint8Array,
  eckId: number,
  roster: RosterContent,
): VerifiedEvent {
  const { identifier } = splitCoordinate(ctx.coordinate);
  const content: RosterContent = { ...roster, eck_current: eckId };
  return finalizeEvent(
    {
      kind: KIND_ROSTER,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", identifier],
        ["a", ctx.coordinate],
        ["eck", String(eckId)],
        ["v", "1"],
      ],
      content: eckEncrypt(eckBytes, JSON.stringify(content)),
    },
    eidSk,
  );
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
 */
export async function sendAdminCommand(
  ctx: EventContext,
  cmd: "approve" | "recompute" | "reprocess" | "revoke" | "talk_publish" | "talk_reject",
  args: Record<string, unknown> = {},
): Promise<void> {
  if (!ctx.config.coordinator) throw new Error("no coordinator attached");
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys?.eidNsecHex) throw new Error("organizer E_id key not available");
  const eidSk = hexToBytes(keys.eidNsecHex);
  const wrap = wrapRumor(eidSk, ctx.config.coordinator, {
    kind: KIND_ADMIN_COMMAND,
    content: { v: 1, a: ctx.coordinate, cmd, args },
  });
  await publishOrQueue(wrap as any, ctx.config.relays);
}

/**
 * Add a co-organizer (spec §6.1, §13). Gift-wraps the event's keys (E_id, E_inbox,
 * ECK) to the co-organizer's pubkey so they get full organizer custody — they can
 * edit the event, approve attendees, and manage the coordinator. Their client
 * picks it up via the normal grant-receiving path.
 */
export async function addCoOrganizer(
  organizer: AppSigner,
  ctx: EventContext,
  coOrganizerPubkey: string,
): Promise<void> {
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys || keys.role !== "organizer" || !keys.eidNsecHex || !keys.einboxNsecHex) {
    throw new Error("organizer keys not available on this device");
  }
  const eidSk = hexToBytes(keys.eidNsecHex);
  // Sealed by E_id: the recipient's C2 authentication of a 21605 organizer grant
  // requires the seal author to be E_id (authenticateOrganizerGrant).
  const wrap = wrapRumor(eidSk, coOrganizerPubkey, {
    kind: KIND_ORGANIZER_GRANT,
    content: {
      v: 1,
      a: ctx.coordinate,
      eid_nsec: keys.eidNsecHex,
      einbox_nsec: keys.einboxNsecHex,
      eck: keys.eck,
      config_relays: ctx.config.relays,
      granted_by: getPublicKey(eidSk),
    },
  });
  await publishOrQueue(wrap as any, ctx.config.relays);
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
}

/**
 * Generate N single-use invite codes (spec §6.5). Each code IS an nsec; the
 * organizer publishes only sha256(invite-pubkey) in a replaceable 31601 (so
 * observers can't enumerate or front-run codes). The nsec rides the link's URL
 * fragment and never touches a server.
 */
export async function generateInvites(
  organizer: AppSigner,
  ctx: EventContext,
  count: number,
  appBaseUrl: string,
  labelPrefix = "invite",
): Promise<GeneratedInvite[]> {
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys?.eidNsecHex) throw new Error("organizer E_id key not available");
  const eidSk = hexToBytes(keys.eidNsecHex);

  // Merge with any already-published invite hashes (replaceable event).
  const existing = await fetchEvents(
    { kinds: [KIND_INVITE_LIST], authors: [ctx.config.eidPubkey], "#d": [splitCoordinate(ctx.coordinate).identifier] },
    ctx.config.relays,
  );
  const latest = existing.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  let invites: { h: string; label?: string }[] = [];
  if (latest) {
    try {
      invites = inviteListContentSchema.parse(JSON.parse(latest.content)).invites;
    } catch {
      invites = [];
    }
  }

  const generated: GeneratedInvite[] = [];
  const base = appBaseUrl.replace(/[#/]+$/, "");
  for (let i = 0; i < count; i++) {
    const sk = generateSecretKey();
    const label = `${labelPrefix}-${invites.length + 1}`;
    invites.push({ h: inviteHash(getPublicKey(sk)), label });
    const nsec = nsecEncode(sk);
    generated.push({
      label,
      nsec,
      link: `${base}/#/e/${encodeURIComponent(ctx.naddr)}/join?code=${nsec}`,
    });
  }

  const identifier = splitCoordinate(ctx.coordinate).identifier;
  const event = finalizeEvent(
    {
      kind: KIND_INVITE_LIST,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", identifier], ["a", ctx.coordinate], ["v", "1"]],
      content: JSON.stringify({ v: 1, invites }),
    },
    eidSk,
  );
  await publishOrQueue(event, ctx.config.relays);
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
): Promise<void> {
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys || keys.role !== "organizer" || !keys.eidNsecHex) {
    throw new Error("organizer keys not available");
  }
  const eidSk = hexToBytes(keys.eidNsecHex);
  const eidPubkey = ctx.config.eidPubkey;
  const prevEck = currentEck(keys);
  if (!prevEck) throw new Error("no ECK available");
  const prevEckBytes = base64ToBytes(prevEck.key);

  // 1. Delete the removed attendee's directory entry (NIP-09), addressed by its
  //    blinded d under the current ECK.
  const removedD = blindedD(prevEckBytes, ctx.coordinate, removedPubkey);
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

  // 2. Mint ECK v(n+1) and persist locally.
  const newId = keys.eck.reduce((m, v) => Math.max(m, v.id), 0) + 1;
  const newEck: EckVersion = { id: newId, key: bytesToBase64(generateEck()) };
  keys.eck = [...keys.eck, newEck];
  await saveEventKeys(keys);
  const newEckBytes = base64ToBytes(newEck.key);

  // 3. Read the current roster, drop the removed attendee, re-encrypt everyone
  //    else's directory entry under the new ECK, and re-grant to each.
  const roster = await loadRoster(ctx, prevEckBytes, keys.eck);
  const remaining = roster.attendees.filter((a) => a.pubkey !== removedPubkey);
  const publisher = directoryPublisher(ctx);
  const newRoster: RosterContent = { v: 1, eck_current: newId, attendees: [] };
  const pubs: Promise<unknown>[] = [publishOrQueue(deletion, ctx.config.relays)];

  for (const a of remaining) {
    // Fetch + decrypt the attendee's current entry (old ECK).
    const events = await fetchEvents(
      { kinds: [KIND_DIRECTORY_ENTRY], authors: [publisher], "#d": [a.d] },
      ctx.config.relays,
    );
    const latest = events.sort((x, y) => (y.created_at ?? 0) - (x.created_at ?? 0))[0];
    let content: unknown;
    try {
      content = latest ? JSON.parse(eckDecrypt(prevEckBytes, latest.content)) : undefined;
    } catch {
      content = undefined;
    }
    const newD = blindedD(newEckBytes, ctx.coordinate, a.pubkey);
    newRoster.attendees.push({ pubkey: a.pubkey, d: newD, role: a.role });

    if (content) {
      const entryEvent = finalizeEvent(
        {
          kind: KIND_DIRECTORY_ENTRY,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["d", newD], ["a", ctx.coordinate], ["eck", String(newId)], ["v", "1"]],
          content: eckEncrypt(newEckBytes, JSON.stringify(content)),
        },
        eidSk,
      );
      pubs.push(publishOrQueue(entryEvent, ctx.config.relays));
    }

    // Re-grant the new ECK set (all versions) to this attendee — sealed by E_id
    // so C2 authentication accepts it.
    const grantWrap = wrapRumor(eidSk, a.pubkey, {
      kind: KIND_KEY_GRANT,
      content: {
        v: 1,
        a: ctx.coordinate,
        role: a.role,
        eck: keys.eck,
        granted_by: getPublicKey(eidSk),
      },
    });
    pubs.push(publishOrQueue(grantWrap as any, ctx.config.relays));
  }

  pubs.push(publishOrQueue(buildRosterEvent(ctx, eidSk, newEckBytes, newId, newRoster), ctx.config.relays));
  await Promise.all(pubs);
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
/**
 * Republish the event's 31600 config with changed fields (signed by E_id). Used by
 * Admin to flip live-editable settings like the prerecorded-talks mode (spec F2).
 * Every other field is preserved from `ctx.config`, so a talks-off event's config
 * stays byte-identical except for the one changed tag.
 */
export async function updateEventConfig(
  ctx: EventContext,
  changes: Partial<{ talks: TalksMode; maxTalkSec: number; chat: ChatBackend[] }>,
): Promise<void> {
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys || keys.role !== "organizer" || !keys.eidNsecHex) {
    throw new Error("organizer E_id key not available");
  }
  const eidSk = hexToBytes(keys.eidNsecHex);
  const built = buildEventConfig({ ...ctx.config, ...changes });
  const configEvent = finalizeEvent(
    {
      kind: built.kind,
      created_at: Math.floor(Date.now() / 1000),
      tags: built.tags,
      content: built.content,
    },
    eidSk,
  );
  await publishOrQueue(configEvent, ctx.config.relays);
}

export async function attachCoordinator(
  _organizer: AppSigner,
  ctx: EventContext,
  coordinatorPubkey: string,
): Promise<void> {
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys || keys.role !== "organizer" || !keys.eidNsecHex || !keys.einboxNsecHex) {
    throw new Error("organizer keys not available on this device");
  }
  const eidSk = hexToBytes(keys.eidNsecHex);

  // 1. Republish 31600 with the coordinator tag (signed by E_id).
  const cfg = { ...ctx.config, coordinator: coordinatorPubkey };
  const built = buildEventConfig(cfg);
  const configEvent = finalizeEvent(
    {
      kind: built.kind,
      created_at: Math.floor(Date.now() / 1000),
      tags: built.tags,
      content: built.content,
    },
    eidSk,
  );

  // 2. Gift-wrap the Coordinator Grant (21603), sealed by E_id so the
  //    coordinator can authenticate the install against the coordinate (F2).
  const grantWrap = wrapRumor(eidSk, coordinatorPubkey, {
    kind: KIND_COORDINATOR_GRANT,
    content: {
      v: 1,
      a: ctx.coordinate,
      inbox_nsec: keys.einboxNsecHex,
      eck: keys.eck,
      config_relays: ctx.config.relays,
    },
  });

  await Promise.all([
    publishOrQueue(configEvent, ctx.config.relays),
    publishOrQueue(grantWrap as any, ctx.config.relays),
  ]);
}
