/**
 * Nostr event kind constants used across Nostrautica (spec §7).
 *
 * Custom kinds occupy the addressable block 31600–31610 and the gift-wrap
 * "rumor" block 21600–21609 (21607 = Marmot chat-key attestation). Rumor kinds sit
 * in the ephemeral range on purpose:
 * rumors are never published as signed events, and a leaked one won't be stored
 * by relays.
 *
 * NOTE (spec §15): 31600–31609 / 21600–21604 were unassigned in the NIPs registry
 * as of 2026-07. 31610 (Talk, F2) extends PAST the originally-reserved 31600–31609
 * block and 21609 (Talk Submission) past 21608 — re-check the NIPs registry for
 * both before first public release.
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
// 31610 extends past the reserved 31600–31609 block (see NOTE above; NIPs re-check).
export const KIND_TALK = 31610; // Talk (ECK) — a prerecorded talk, blinded d per talk (F2)
// Coordinator Announcement (public, replaceable, signed by the coordinator key):
// self-description for discovery, so organizers can pick a coordinator instead of
// pasting an npub (docs/COORDINATOR-DISCOVERY-PLAN.md). d = "nostrautica:coordinator".
export const KIND_COORDINATOR_ANNOUNCE = 31611;
export const COORDINATOR_ANNOUNCE_D = "nostrautica:coordinator";

// ── Custom gift-wrap rumor kinds (21600–21604) ──────────────────────────────
export const KIND_JOIN_REQUEST = 21600; // → E_inbox
export const KIND_PROFILE_SUBMISSION = 21601; // → E_inbox
export const KIND_KEY_GRANT = 21602; // → attendee
export const KIND_COORDINATOR_GRANT = 21603; // → coordinator
export const KIND_ADMIN_COMMAND = 21604; // organizer → coordinator
export const KIND_ORGANIZER_GRANT = 21605; // → co-organizer (E_id + E_inbox + ECK)
export const KIND_COORDINATOR_STATUS = 21606; // coordinator → organizer (poison/health, Q12)
// Marmot group chat (MARMOT-GROUP-CHAT §3.3): a chat-key attestation binds an
// app-generated chat device key to an account (for NIP-46/NIP-07 users, who cannot
// raw-sign the MLS identity proof). Gift-wrapped attendee → coordinator, sealed by
// the account key. Local-key accounts don't need it (they sign the proof directly).
export const KIND_CHAT_KEY_ATTESTATION = 21607;
export const KIND_PROFILE_CORRECTION = 21608; // attendee → E_inbox (correct/hide own ai_profile, F3)
export const KIND_TALK_SUBMISSION = 21609; // attendee → E_inbox (submit/edit a prerecorded talk, F2)

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
  KIND_CHAT_KEY_ATTESTATION,
  KIND_PROFILE_CORRECTION,
  KIND_TALK_SUBMISSION,
] as const;

export type RumorKind = (typeof RUMOR_KINDS)[number];
