/** Organizer edits for the public NIP-52 event and its event-identity profile. */
import { finalizeEvent } from "nostr-tools/pure";
import {
  KIND_CALENDAR_EVENT,
  KIND_PROFILE,
  hexToBytes,
  parseCoordinate,
} from "@nostrautica/protocol";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { publishMonotonic } from "$lib/nostr/monotonic.js";
import { toOutcome, type PublishOutcome } from "$lib/nostr/publish-queue.js";
import { onlyVerified } from "$lib/nostr/verify.js";
import { loadEventKeys } from "./keystore.js";
import { dayIndexTags } from "./create.js";
import { cacheEventContext, type EventContext } from "./event-context.js";
import type { VerifiedEvent } from "nostr-tools/pure";

export interface EventMetadataInput {
  title: string;
  summary: string;
  start: number;
  end?: number;
  location?: string;
  icon?: string;
  banner?: string;
}

// Tags this editor OWNS and fully rebuilds from `input` on every edit. `D`
// (NIP-52 day index, R5) MUST be here: without it a start/end date change kept
// the old `D` tags, leaving the event indexed under its former days. Lowercase
// `d` (the address identifier) is preserved separately below, never dropped.
const MANAGED_TAGS = new Set(["title", "summary", "start", "end", "location", "image", "D"]);

function latest<T extends { created_at?: number }>(events: T[]): T | undefined {
  return events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
}

/**
 * Republish the addressable 31923 and replaceable kind-0 under E_id. Unknown
 * NIP-52 tags are retained so editing in Nostrautica does not discard metadata
 * added by another calendar client.
 */
export interface UpdateMetadataResult {
  ctx: EventContext;
  /** Worst-case outcome across the 31923 + kind-0 republish (R9): `queued` if
   *  either only landed in the durable outbox, so the UI never claims a
   *  WSS-blocked edit as live. */
  outcome: PublishOutcome;
}

export async function updateEventMetadata(
  ctx: EventContext,
  input: EventMetadataInput,
): Promise<UpdateMetadataResult> {
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys || keys.role !== "organizer" || !keys.eidNsecHex) {
    throw new Error("organizer E_id key not available");
  }
  const { pubkey, identifier } = parseCoordinate(ctx.coordinate);
  const [calendarEvents, profileEvents] = await Promise.all([
    fetchEvents(
      { kinds: [KIND_CALENDAR_EVENT], authors: [pubkey], "#d": [identifier] },
      ctx.config.relays,
    ).then(onlyVerified),
    fetchEvents({ kinds: [KIND_PROFILE], authors: [pubkey] }, ctx.config.relays).then(onlyVerified),
  ]);
  const priorCalendar = latest(calendarEvents);
  const priorProfile = latest(profileEvents);
  let profile: Record<string, unknown> = {};
  if (priorProfile) {
    try {
      profile = JSON.parse(priorProfile.content) as Record<string, unknown>;
    } catch {
      profile = {};
    }
  }

  const preservedTags = (priorCalendar?.tags ?? [["d", identifier]]).filter(
    (tag) => !MANAGED_TAGS.has(tag[0] ?? ""),
  );
  if (!preservedTags.some((tag) => tag[0] === "d")) preservedTags.unshift(["d", identifier]);
  const tags: string[][] = [
    ...preservedTags,
    ["title", input.title],
    ["start", String(input.start)],
  ];
  if (input.end) tags.push(["end", String(input.end)]);
  // Rebuild the NIP-52 `D` day-index tags from the (possibly changed) dates (R5)
  // — MANAGED_TAGS dropped the stale ones above, so a date edit re-indexes the
  // event under its new days instead of keeping the old ones.
  for (const t of dayIndexTags(input.start, input.end)) tags.push(t);
  if (input.summary) tags.push(["summary", input.summary]);
  if (input.banner) tags.push(["image", input.banner]);
  if (input.location) tags.push(["location", input.location]);

  const eidSk = hexToBytes(keys.eidNsecHex);
  // Both replaceable/addressable publishers go through the monotonic helper
  // (R6): each reserves a §3.1-winning created_at per address atomically, so a
  // same-second re-edit can't tie-and-lose on the id comparison.
  const [calendarRes, profileRes] = await Promise.all([
    publishMonotonic({
      kind: KIND_CALENDAR_EVENT,
      author: pubkey,
      identifier,
      relays: ctx.config.relays,
      owner: pubkey,
      sign: (created_at) =>
        finalizeEvent(
          { kind: KIND_CALENDAR_EVENT, created_at, tags, content: input.summary },
          eidSk,
        ) as VerifiedEvent,
    }),
    publishMonotonic({
      kind: KIND_PROFILE,
      author: pubkey,
      relays: ctx.config.relays,
      owner: pubkey,
      sign: (created_at) =>
        finalizeEvent(
          {
            kind: KIND_PROFILE,
            created_at,
            tags: priorProfile?.tags ?? [],
            content: JSON.stringify({
              ...profile,
              name: input.title,
              about: input.summary,
              ...(input.icon ? { picture: input.icon } : { picture: undefined }),
              ...(input.banner ? { banner: input.banner } : { banner: undefined }),
            }),
          },
          eidSk,
        ) as VerifiedEvent,
    }),
  ]);

  const contextAt = Math.max(calendarRes.createdAt, profileRes.createdAt);
  const updated: EventContext = {
    ...ctx,
    title: input.title,
    summary: input.summary,
    start: input.start,
    end: input.end,
    location: input.location,
    icon: input.icon,
    banner: input.banner,
    contextAt,
  };
  cacheEventContext(updated, contextAt);
  return { ctx: updated, outcome: toOutcome(calendarRes.published && profileRes.published) };
}
