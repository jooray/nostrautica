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

/**
 * One entry per person actually in the chat — the roster attendees that have at
 * least one attested device key. Deduped by account by construction (the roster
 * holds one entry per attendee); `deviceCount` drives the subtle "N devices" affix.
 * Organizers first, then by device pubkey for a stable order (the component sorts by
 * resolved display name once profiles load).
 */
export function chatMembers(roster: RosterContent | undefined): ChatMember[] {
  const members: ChatMember[] = [];
  for (const a of roster?.attendees ?? []) {
    const keys = a.chat_keys ?? [];
    if (keys.length === 0) continue;
    members.push({
      account: a.pubkey,
      role: a.role,
      deviceCount: keys.length,
      devices: keys.map((k) => ({ pubkey: k.pubkey, label: k.label, added_at: k.added_at })),
    });
  }
  members.sort((x, y) => {
    if (x.role !== y.role) return x.role === "organizer" ? -1 : 1;
    return x.account < y.account ? -1 : x.account > y.account ? 1 : 0;
  });
  return members;
}

/** The attested devices for one account (for the "Chat devices" management UI). */
export function devicesForAccount(
  roster: RosterContent | undefined,
  account: string,
): { pubkey: string; label?: string; added_at: number }[] {
  const entry = roster?.attendees.find((a) => a.pubkey === account);
  return (entry?.chat_keys ?? []).map((k) => ({ pubkey: k.pubkey, label: k.label, added_at: k.added_at }));
}
