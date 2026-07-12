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
  eckEncrypt,
  blindedD,
  nip44Encrypt,
  wrapRumor,
  parseCoordinate,
  type EckVersion,
  type DirectoryEntryContent,
  type RosterContent,
  type MatchListContent,
  type MatchMatrixContent,
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
