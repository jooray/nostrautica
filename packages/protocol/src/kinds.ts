/**
 * Nostr event kind constants used across Nostrautica (spec §7).
 *
 * Custom kinds occupy the addressable block 31600–31609 and the gift-wrap
 * "rumor" block 21600–21604. Rumor kinds sit in the ephemeral range on purpose:
 * rumors are never published as signed events, and a leaked one won't be stored
 * by relays.
 *
 * NOTE (spec §15): 31600–31609 / 21600–21604 were unassigned in the NIPs registry
 * as of 2026-07. Re-check before first public release.
 */

// ── Reused standard kinds ────────────────────────────────────────────────────
export const KIND_PROFILE = 0; // NIP-01 metadata (kind 0)
export const KIND_NOTE = 1; // NIP-01 short text note
export const KIND_CONTACTS = 3; // NIP-02 follow list
export const KIND_REPOST = 6; // NIP-18 repost
export const KIND_DELETION = 5; // NIP-09 event deletion request
export const KIND_SEAL = 13; // NIP-59 seal
export const KIND_DM = 14; // NIP-17 private direct message (rumor only, never signed)
export const KIND_LONGFORM = 30023; // NIP-23 long-form content
export const KIND_RELAY_LIST = 10002; // NIP-65 relay list metadata
export const KIND_DM_RELAY_LIST = 10050; // NIP-17 DM relay list (where to receive gift-wrapped DMs)
export const KIND_MUTE_LIST = 10000; // NIP-51 mute list
export const KIND_BLOSSOM_SERVERS = 10063; // BUD-03 user server list
export const KIND_GIFT_WRAP = 1059; // NIP-59 gift wrap
export const KIND_APP_DATA = 30078; // NIP-78 arbitrary app data
export const KIND_BLOSSOM_AUTH = 24242; // Blossom authorization event

// NIP-52 calendar
export const KIND_CALENDAR_EVENT = 31923; // time-based calendar event
export const KIND_CALENDAR = 31924; // calendar (collection)
export const KIND_CALENDAR_RSVP = 31925; // calendar event RSVP

// Routstr provider announcement (v2, spec §9.4)
export const KIND_ROUTSTR_PROVIDER = 38421;

// ── Custom addressable kinds (31600–31609) ──────────────────────────────────
export const KIND_EVENT_CONFIG = 31600; // Event Networking Config
export const KIND_INVITE_LIST = 31601; // Invite List
export const KIND_MY_PROFILE = 31602; // My Event Profile / intro library (self-enc)
export const KIND_DIRECTORY_ENTRY = 31603; // Directory Entry (ECK)
export const KIND_ROSTER = 31604; // Roster index (ECK)
export const KIND_MATCH_LIST = 31605; // per-attendee Match List (nip44 → recipient)
export const KIND_MATCH_MATRIX = 31606; // event-wide Match Matrix (ECK, opt-in)
export const KIND_MEMBERS_POST = 31607; // Members-only Event Post (ECK, random d)
export const KIND_EVENT_PAGE = 31608; // Event Page — menu + layout (d = event-d)
export const KIND_EVENT_THEME = 31609; // Event Theme — raw CSS (d = event-d)

// ── Custom gift-wrap rumor kinds (21600–21604) ──────────────────────────────
export const KIND_JOIN_REQUEST = 21600; // → E_inbox
export const KIND_PROFILE_SUBMISSION = 21601; // → E_inbox
export const KIND_KEY_GRANT = 21602; // → attendee
export const KIND_COORDINATOR_GRANT = 21603; // → coordinator
export const KIND_ADMIN_COMMAND = 21604; // organizer → coordinator
export const KIND_ORGANIZER_GRANT = 21605; // → co-organizer (E_id + E_inbox + ECK)
export const KIND_COORDINATOR_STATUS = 21606; // coordinator → organizer (poison/health, Q12)

/** Rumor kinds — the set of kinds ever delivered inside a NIP-59 gift wrap. */
export const RUMOR_KINDS = [
  KIND_DM,
  KIND_JOIN_REQUEST,
  KIND_PROFILE_SUBMISSION,
  KIND_KEY_GRANT,
  KIND_COORDINATOR_GRANT,
  KIND_ADMIN_COMMAND,
  KIND_ORGANIZER_GRANT,
  KIND_COORDINATOR_STATUS,
] as const;

export type RumorKind = (typeof RUMOR_KINDS)[number];
