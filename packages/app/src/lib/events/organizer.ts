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
  type VerifiedEvent,
} from "nostr-tools/pure";

import {
  KIND_GIFT_WRAP,
  KIND_JOIN_REQUEST,
  KIND_PROFILE_SUBMISSION,
  KIND_KEY_GRANT,
  KIND_DIRECTORY_ENTRY,
  KIND_ROSTER,
  giftwrapSince,
  unwrapRumor,
  eckEncrypt,
  base64ToBytes,
  hexToBytes,
  blindedD,
  joinRequestContentSchema,
  profileSubmissionContentSchema,
  isInviteValid,
  buildEventConfig,
  KIND_COORDINATOR_GRANT,
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
import { loadEventKeys, currentEck } from "./keystore.js";
import { signerWrap } from "./giftwrap.js";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";

export interface PendingRequest {
  attendeePubkey: string;
  name: string;
  message: string;
  rsvpPublic: boolean;
  profile?: AttendeeProfile;
  media?: MediaDescriptor[];
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
  const wraps = (await fetchEvents(
    { kinds: [KIND_GIFT_WRAP], "#p": [getPublicKey(einboxSk)], since: giftwrapSince() },
    ctx.config.relays,
  )) as unknown as GiftWrap[];

  const byAttendee = new Map<string, PendingRequest>();
  const submissions = new Map<
    string,
    { at: number; profile: AttendeeProfile; media: MediaDescriptor[] }
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
    }
  }
  return [...byAttendee.values()].sort((a, b) => a.rumorCreatedAt - b.rumorCreatedAt);
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

  // 1. Key grant (21602) → attendee, sealed by the organizer.
  const grant = {
    v: 1,
    a: ctx.coordinate,
    role,
    eck: keys.eck,
    granted_by: await organizer.getPublicKey(),
  };
  const grantWrap = await signerWrap(organizer, req.attendeePubkey, {
    kind: KIND_KEY_GRANT,
    content: grant,
  });

  // 2. Directory entry (31603) under ECK, blinded d over ECK, signed by E_id.
  const entryD = blindedD(eckBytes, ctx.coordinate, req.attendeePubkey);
  const entryContent = {
    v: 1,
    pubkey: req.attendeePubkey,
    profile: req.profile ?? { about: "", skills: [], looking_for: "", links: [] },
    media: req.media ?? [],
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

/** Fetch + decrypt the current roster (or an empty one if none exists yet). */
export async function loadRoster(
  ctx: EventContext,
  eckBytes: Uint8Array,
  eckVersions: EckVersion[],
): Promise<RosterContent> {
  const publisher = directoryPublisher(ctx);
  const { identifier } = splitCoordinate(ctx.coordinate);
  const events = await fetchEvents(
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
 * Attach a coordinator to the event (spec §8): republish the 31600 config with a
 * `coordinator` tag (signed by E_id) and gift-wrap a Coordinator Grant (21603)
 * carrying the E_inbox secret + ECK so it can read submissions. Installation is
 * protocol-level — no per-event server config.
 */
export async function attachCoordinator(
  organizer: AppSigner,
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

  // 2. Gift-wrap the Coordinator Grant (21603), sealed by the organizer.
  const grantWrap = await signerWrap(organizer, coordinatorPubkey, {
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
