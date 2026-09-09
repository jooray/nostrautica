/**
 * Roster-driven account/device mapping for chat (NIP §10.1, member-list dedupe).
 *
 * Each chat member the wire shows is a per-DEVICE key; one person may hold several
 * (phone + laptop). The ECK roster's `chat_keys` binds those device keys to one
 * account per attendee, so these pure helpers turn "N device keys" into "one person
 * with N devices": {@link buildDeviceAccountMap} resolves a message sender's device
 * key back to its account (so two devices of one person attribute to the same name
 * and colour), and {@link chatMembers} lists one entry per person with a device
 * count. Both are network-free and unit-tested; display names/avatars are resolved
 * by the component from profiles keyed on the account (or the device key as fallback).
 */
import type { RosterContent } from "@nostrautica/protocol";

/**
 * Map every attested device chat key → its owning account pubkey (and each account
 * to itself, so an account-key sender resolves to itself). A device key not present
 * in any attendee's `chat_keys` is simply absent — callers fall back to the device
 * key itself (then its device kind-0, then a truncated key).
 */
export function buildDeviceAccountMap(roster: RosterContent | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of roster?.attendees ?? []) {
    map.set(a.pubkey, a.pubkey);
    for (const k of a.chat_keys ?? []) map.set(k.pubkey, a.pubkey);
  }
  return map;
}

/** Resolve a device (or account) pubkey to its account via the roster map, else itself. */
export function accountForDevice(
  devicePubkey: string,
  deviceAccountMap: Map<string, string>,
): string {
  return deviceAccountMap.get(devicePubkey) ?? devicePubkey;
}

/** One person in the chat: their account pubkey and how many devices they've attested. */
export interface ChatMember {
  account: string;
  role: "attendee" | "organizer";
  deviceCount: number;
  /** The attested device keys, for the account's own device-management UI. */
  devices: { pubkey: string; label?: string; added_at: number }[];
}

/** What a member list is derived from — the UI has to say which, they differ. */
export type ChatMembership =
  /** Real MLS membership: these devices hold a leaf in the group right now. */
  | "group"
  /** Roster `chat_keys` only: who has ATTESTED. A superset AND a subset — see below. */
  | "attested";

export interface ChatMemberList {
  members: ChatMember[];
  source: ChatMembership;
}

/**
 * One entry per person in the chat.
 *
 * `groupDevices` — the device pubkeys that actually hold a leaf in this event's
 * MLS group (`MarmotChat.groupMemberPubkeys`) — is the authoritative answer, and
 * when it is available the list is filtered to it. Pass `undefined` when it is
 * genuinely unknown (no group state yet, a follower tab before the leader's first
 * broadcast); the result then falls back to the roster and says so through
 * `source`, so the UI can label it rather than quietly presenting one as the
 * other.
 *
 * The two sets are NOT interchangeable, in both directions:
 *
 *  - Attested but NOT in the group: a device whose Add never landed — an
 *    ineligible key package, an invite that threw, a Welcome that was never
 *    decryptable. It is in the roster's `chat_keys` (so it was listed as present)
 *    and it cannot read a single message.
 *  - In the group but NOT yet in the roster: the coordinator adds a member and
 *    republishes the 31604 separately, so there is a window where a real member is
 *    missing from the list. These are kept, as a synthetic entry when the roster
 *    has no row for them at all, rather than being hidden.
 *
 * Deduped by account by construction (the roster holds one entry per attendee);
 * `deviceCount` drives the subtle "N devices" affix and counts PRESENT devices
 * when membership is known. Organizers first, then by account pubkey for a stable
 * order (the component re-sorts by resolved display name once profiles load).
 */
export function chatMembers(
  roster: RosterContent | undefined,
  opts?: {
    /** Device pubkeys holding a leaf in this event's group; omit when unknown. */
    groupDevices?: readonly string[];
    /**
     * Device pubkeys to leave out of the list even when they hold a leaf — in
     * practice the coordinator's own admin leaf. It really is in the group (that
     * is what the §4.5 coordinator-read disclosure is about), but it is not a
     * person in the room, and rendering it as one alongside an avatar and a name
     * would read as a mystery attendee rather than as the disclosure.
     */
    exclude?: readonly string[];
  },
): ChatMemberList {
  const excluded = new Set(opts?.exclude ?? []);
  const present = opts?.groupDevices
    ? new Set(opts.groupDevices.filter((p) => !excluded.has(p)))
    : undefined;
  const members: ChatMember[] = [];
  const accounted = new Set<string>();
  for (const a of roster?.attendees ?? []) {
    const keys = a.chat_keys ?? [];
    const shown = present ? keys.filter((k) => present.has(k.pubkey)) : keys;
    for (const k of shown) accounted.add(k.pubkey);
    if (shown.length === 0) continue;
    members.push({
      account: a.pubkey,
      role: a.role,
      deviceCount: shown.length,
      devices: shown.map((k) => ({ pubkey: k.pubkey, label: k.label, added_at: k.added_at })),
    });
  }
  // Devices in the group that no roster row claims. One entry each, keyed by the
  // device pubkey (the caller's profile lookup falls back to the device kind-0),
  // because a real member the roster hasn't caught up with is still in the room
  // and their messages are already arriving.
  for (const pubkey of present ?? []) {
    if (accounted.has(pubkey)) continue;
    members.push({ account: pubkey, role: "attendee", deviceCount: 1, devices: [{ pubkey, added_at: 0 }] });
  }
  members.sort((x, y) => {
    if (x.role !== y.role) return x.role === "organizer" ? -1 : 1;
    return x.account < y.account ? -1 : x.account > y.account ? 1 : 0;
  });
  return { members, source: present ? "group" : "attested" };
}

/** The attested devices for one account (for the "Chat devices" management UI). */
export function devicesForAccount(
  roster: RosterContent | undefined,
  account: string,
): { pubkey: string; label?: string; added_at: number }[] {
  const entry = roster?.attendees.find((a) => a.pubkey === account);
  return (entry?.chat_keys ?? []).map((k) => ({ pubkey: k.pubkey, label: k.label, added_at: k.added_at }));
}
