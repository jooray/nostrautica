/**
 * Coordinator publishing (spec §7.3, §6.4). The coordinator authors directory
 * entries (31603), the roster (31604), per-attendee match lists (31605), and the
 * optional matrix (31606) under the ECK, plus ECK grants (21602) as gift wraps.
 * All signed by the coordinator's own key.
 */
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { Event as NostrEvent } from "nostr-tools/core";
import {
  KIND_DIRECTORY_ENTRY,
  KIND_ROSTER,
  KIND_MATCH_LIST,
  KIND_MATCH_MATRIX,
  KIND_KEY_GRANT,
  KIND_COORDINATOR_STATUS,
  KIND_COORDINATOR_ANNOUNCE,
  COORDINATOR_ANNOUNCE_D,
  KIND_TALK,
  eckEncrypt,
  blindedD,
  blindedDLiteral,
  nip44Encrypt,
  wrapRumor,
  parseCoordinate,
  type EckVersion,
  type DirectoryEntryContent,
  type RosterContent,
  type MatchListContent,
  type MatchMatrixContent,
  type CoordinatorStatusContent,
  type CoordinatorAnnounce,
  type TalkContent,
} from "@nostrautica/protocol";

export interface PublishKeys {
  coordSk: Uint8Array;
  eck: Uint8Array;
  eckId: number;
}

/** kind 31603 directory entry (ECK, blinded d over ECK). */
export function buildDirectoryEntry(
  keys: PublishKeys,
  coordinate: string,
  entry: DirectoryEntryContent,
): NostrEvent {
  const d = blindedD(keys.eck, coordinate, entry.pubkey);
  return finalizeEvent(
    {
      kind: KIND_DIRECTORY_ENTRY,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", d],
        ["a", coordinate],
        ["eck", String(keys.eckId)],
        ["v", "1"],
      ],
      content: eckEncrypt(keys.eck, JSON.stringify(entry)),
    },
    keys.coordSk,
  );
}

/** kind 31604 roster (ECK, d = event-d). */
export function buildRoster(
  keys: PublishKeys,
  coordinate: string,
  roster: RosterContent,
): NostrEvent {
  const { identifier } = parseCoordinate(coordinate);
  return finalizeEvent(
    {
      kind: KIND_ROSTER,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", identifier],
        ["a", coordinate],
        ["eck", String(keys.eckId)],
        ["v", "1"],
      ],
      content: eckEncrypt(keys.eck, JSON.stringify(roster)),
    },
    keys.coordSk,
  );
}

/** kind 31605 match list (NIP-44 coordinator→recipient, blinded d over ECK). */
export function buildMatchListEvent(
  keys: PublishKeys,
  coordinate: string,
  recipientPubkey: string,
  content: MatchListContent,
): NostrEvent {
  const d = blindedD(keys.eck, coordinate, recipientPubkey);
  return finalizeEvent(
    {
      kind: KIND_MATCH_LIST,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", d],
        ["a", coordinate],
        ["v", "1"],
      ],
      // Encrypted to the recipient so only the pair's two members read reasoning.
      content: nip44Encrypt(keys.coordSk, recipientPubkey, JSON.stringify(content)),
    },
    keys.coordSk,
  );
}

/** kind 31606 match matrix (ECK, scores only — reasoning stays pairwise). */
export function buildMatchMatrix(
  keys: PublishKeys,
  coordinate: string,
  content: MatchMatrixContent,
): NostrEvent {
  const { identifier } = parseCoordinate(coordinate);
  return finalizeEvent(
    {
      kind: KIND_MATCH_MATRIX,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", identifier],
        ["a", coordinate],
        ["eck", String(keys.eckId)],
        ["v", "1"],
      ],
      content: eckEncrypt(keys.eck, JSON.stringify(content)),
    },
    keys.coordSk,
  );
}

/**
 * The blinded `d` for a talk (spec F2). Deterministic from the ECK + coordinate +
 * speaker + the speaker-chosen `talk_d`, so the coordinator and every member client
 * derive the same address. A bumped revision keeps the same `d` (replaceable), so a
 * new publish replaces the last one in place.
 */
export function talkBlindedD(eck: Uint8Array, coordinate: string, pubkey: string, talkD: string): string {
  return blindedDLiteral(eck, `talk|${coordinate}|${pubkey}|${talkD}`);
}

/** kind 31610 Talk (ECK, blinded d per talk). Members-only, like the directory. */
export function buildTalkEntry(
  keys: PublishKeys,
  coordinate: string,
  content: TalkContent,
): NostrEvent {
  const d = talkBlindedD(keys.eck, coordinate, content.pubkey, content.talk_d);
  return finalizeEvent(
    {
      kind: KIND_TALK,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", d],
        ["a", coordinate],
        ["eck", String(keys.eckId)],
        ["v", "1"],
      ],
      content: eckEncrypt(keys.eck, JSON.stringify(content)),
    },
    keys.coordSk,
  );
}

/** kind 21606 coordinator status → organizer (E_id), gift-wrapped (audit Q12). */
export function buildCoordinatorStatus(
  coordSk: Uint8Array,
  eidPubkey: string,
  content: CoordinatorStatusContent,
): NostrEvent {
  return wrapRumor(coordSk, eidPubkey, {
    kind: KIND_COORDINATOR_STATUS,
    content,
  }) as unknown as NostrEvent;
}

/**
 * kind 31611 Coordinator Announcement — public, replaceable, for discovery
 * (docs/COORDINATOR-DISCOVERY-PLAN.md). Signed by the coordinator's own key.
 */
export function buildCoordinatorAnnounce(
  coordSk: Uint8Array,
  content: CoordinatorAnnounce,
): NostrEvent {
  return finalizeEvent(
    {
      kind: KIND_COORDINATOR_ANNOUNCE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", COORDINATOR_ANNOUNCE_D],
        ["v", "1"],
      ],
      content: JSON.stringify(content),
    },
    coordSk,
  );
}

/** kind 21602 ECK grant → attendee, gift-wrapped and sealed by the coordinator. */
export function buildKeyGrant(
  coordSk: Uint8Array,
  coordinate: string,
  attendeePubkey: string,
  eck: EckVersion[],
  role: "attendee" | "organizer" = "attendee",
): NostrEvent {
  return wrapRumor(coordSk, attendeePubkey, {
    kind: KIND_KEY_GRANT,
    content: {
      v: 1,
      a: coordinate,
      role,
      eck,
      granted_by: getPublicKey(coordSk),
    },
  }) as unknown as NostrEvent;
}
