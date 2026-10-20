/**
 * Space hierarchy (PROTOCOL-NIP.md §15): a community (31612) and the events
 * (31923) that belong to it — a meetup series and its meetups.
 *
 * Membership flows UP: whoever is approved for a child event may join the parent
 * community without a separate approval, by presenting a membership proof signed
 * by an authority of the child. Nothing flows down: a community member is not a
 * member of any event they did not join, and leaving an event does not leave the
 * community.
 *
 * The link is two-sided on purpose. A child names its parent (`parent` tag on the
 * child's 31600) and the parent lists the child (`child` tags on the parent's
 * 31600); each side is signed by its own E_id. Requiring both means the community's
 * organizer decides which events confer membership — an unrelated event naming
 * someone else's community as its parent gains nothing — and the event's organizer
 * decides which community their attendees are offered.
 *
 * The proof is signed by the child's E_id or the coordinator the child's newest
 * 31600 names, and verified by whoever approves joins to the parent (its
 * coordinator, or its organizer's client). The two spaces need not share a
 * coordinator: the verifier reads the child's own config to learn who may sign.
 */
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { getPublicKey } from "nostr-tools/pure";
import { parseCoordinate } from "./coordinate.js";
import { KIND_CALENDAR_EVENT, KIND_COMMUNITY } from "./kinds.js";
import type { EventConfig } from "./config.js";

/** Most child events a community's 31600 may list. */
export const MAX_CHILDREN = 500;

/** Tag on a child event's 31600 naming its parent community. */
export const PARENT_TAG = "parent";
/** Tag on a community's 31600, one per child event. */
export const CHILD_TAG = "child";
/** Tag on a 21600 join request to the parent, carrying a membership proof. */
export const MEMBER_OF_TAG = "member_of";

const MEMBERSHIP_PROOF_TAG = "nostrautica-member-of-v1";
const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;

/** A parent must be a community; a child must be a dated event. */
export function isValidParentCoordinate(coordinate: string): boolean {
  try {
    return parseCoordinate(coordinate).kind === KIND_COMMUNITY;
  } catch {
    return false;
  }
}

export function isValidChildCoordinate(coordinate: string): boolean {
  try {
    return parseCoordinate(coordinate).kind === KIND_CALENDAR_EVENT;
  } catch {
    return false;
  }
}

/**
 * Whether `child` (with config `childCfg`) and `parent` (with config `parentCfg`)
 * are linked: each side's own, E_id-signed config names the other. Callers pass
 * the NEWEST configs (§3.1); a link withdrawn by either side is no link.
 */
export function isLinked(
  parent: string,
  parentCfg: Pick<EventConfig, "children">,
  child: string,
  childCfg: Pick<EventConfig, "parent">,
): boolean {
  return (
    isValidParentCoordinate(parent) &&
    isValidChildCoordinate(child) &&
    childCfg.parent === parent &&
    (parentCfg.children ?? []).includes(child)
  );
}

/**
 * The keys allowed to sign a membership proof for `child`: its E_id and current
 * coordinator. Total, like every other predicate here (audit SB-29): a malformed
 * `child` has no authorities, so nothing verifies against it (fail-closed).
 */
export function membershipAuthorities(
  child: string,
  childCfg: Pick<EventConfig, "coordinator">,
): string[] {
  let eid: string;
  try {
    eid = parseCoordinate(child).pubkey;
  } catch {
    return [];
  }
  return childCfg.coordinator ? [eid, childCfg.coordinator] : [eid];
}

function membershipChallenge(parent: string, child: string, attendee: string): Uint8Array {
  return sha256(utf8ToBytes(JSON.stringify([MEMBERSHIP_PROOF_TAG, parent, child, attendee])));
}

/** A proof that `attendee` is an approved member of `child`, for joining `parent`. */
export interface MembershipProof {
  /** The parent community's coordinate. */
  a: string;
  /** The signer: the child's E_id or its coordinator. */
  by: string;
  /** BIP-340 signature over the §15 challenge, hex. */
  sig: string;
}

export function makeMembershipProof(
  signerSk: Uint8Array,
  parent: string,
  child: string,
  attendee: string,
): MembershipProof {
  return {
    a: parent,
    by: getPublicKey(signerSk),
    sig: bytesToHex(schnorr.sign(membershipChallenge(parent, child, attendee), signerSk)),
  };
}

/**
 * Verify a membership proof. A predicate over untrusted input: malformed fields
 * return false, never throw. `authorities` comes from {@link membershipAuthorities}
 * over the child's NEWEST config, so a proof signed by a since-replaced coordinator
 * stops working once the child moves on — re-grants carry a fresh one.
 */
export function verifyMembershipProof(
  proof: { by: string; sig: string },
  parent: string,
  child: string,
  attendee: string,
  authorities: readonly string[],
): boolean {
  if (!HEX32.test(proof.by) || !HEX64.test(proof.sig) || !HEX32.test(attendee)) return false;
  if (!authorities.includes(proof.by)) return false;
  try {
    return schnorr.verify(hexToBytes(proof.sig), membershipChallenge(parent, child, attendee), proof.by);
  } catch {
    return false;
  }
}

/** `["member_of", <child coordinate>, <by>, <sig>]` for a 21600 to the parent. */
export function memberOfTag(child: string, proof: { by: string; sig: string }): string[] {
  return [MEMBER_OF_TAG, child, proof.by, proof.sig];
}

/** Every well-formed `member_of` tag of a join request (at most 8 are considered). */
export function parseMemberOfTags(tags: string[][]): { child: string; by: string; sig: string }[] {
  return tags
    .filter((t) => t[0] === MEMBER_OF_TAG && t.length >= 4)
    .map((t) => ({ child: t[1]!, by: t[2]!, sig: t[3]! }))
    .filter((p) => isValidChildCoordinate(p.child) && HEX32.test(p.by) && HEX64.test(p.sig))
    .slice(0, 8);
}
