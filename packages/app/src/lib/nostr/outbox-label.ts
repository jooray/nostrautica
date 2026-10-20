/**
 * A human noun for a queued outbox item (audit DS41-021). The outbox stores the
 * OUTER event, so most of what a member queues (join requests, profile
 * submissions, DMs, corrections, talk submissions) is a NIP-59 gift wrap whose
 * real kind is sealed inside it. "Item (kind 1059)" meant nothing to anyone; the
 * best honest label for a wrap is "private message or request".
 */
import {
  KIND_PROFILE,
  KIND_NOTE,
  KIND_CONTACTS,
  KIND_DELETION,
  KIND_LONGFORM,
  KIND_RELAY_LIST,
  KIND_DM_RELAY_LIST,
  KIND_MUTE_LIST,
  KIND_BLOSSOM_SERVERS,
  KIND_GIFT_WRAP,
  KIND_APP_DATA,
  KIND_CALENDAR_EVENT,
  KIND_CALENDAR,
  KIND_CALENDAR_RSVP,
  KIND_MEMBERS_POST,
  KIND_MY_PROFILE,
} from "@nostrautica/protocol";
import type { MessageKey } from "$lib/i18n/messages.js";

export function outboxKindKey(kind: number): MessageKey {
  switch (kind) {
    case KIND_GIFT_WRAP:
      return "outbox.kind.message";
    case KIND_PROFILE:
    case KIND_MY_PROFILE:
      return "outbox.kind.profile";
    case KIND_CONTACTS:
      return "outbox.kind.follows";
    case KIND_DELETION:
      return "outbox.kind.deletion";
    case KIND_NOTE:
    case KIND_LONGFORM:
    case KIND_MEMBERS_POST:
      return "outbox.kind.post";
    case KIND_CALENDAR_RSVP:
      return "outbox.kind.rsvp";
    case KIND_RELAY_LIST:
    case KIND_DM_RELAY_LIST:
    case KIND_MUTE_LIST:
    case KIND_BLOSSOM_SERVERS:
    case KIND_APP_DATA:
      return "outbox.kind.settings";
    case KIND_CALENDAR_EVENT:
    case KIND_CALENDAR:
      return "outbox.kind.event";
  }
  // Nostrautica's own replaceable event records (config, invite list, roster,
  // directory, page, theme, talks, community: 31600-31612).
  if (kind >= 31600 && kind <= 31612) return "outbox.kind.event";
  return "outbox.kind.other";
}
