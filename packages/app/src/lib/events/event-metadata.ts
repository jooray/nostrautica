/** Organizer edits for the public NIP-52 event and its event-identity profile. */
import { finalizeEvent } from "nostr-tools/pure";
import {
  KIND_PROFILE,
  hexToBytes,
  parseCoordinate,
  pickLatest,
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

type MetadataField = keyof EventMetadataInput;
const METADATA_FIELDS: MetadataField[] = ["title", "summary", "start", "end", "location", "icon", "banner"];

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

/**
 * The metadata the newest relay copies carry, read the way event-context reads
 * it (calendar tags first, then the event-identity kind-0), so a field the user
 * did not touch is republished exactly as it currently stands.
 */
function metadataOnRelays(
  calendar: { tags: string[][] },
  profile: Record<string, unknown>,
): EventMetadataInput {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    title: tagValue(calendar.tags, "title") ?? str(profile.name) ?? "",
    summary: tagValue(calendar.tags, "summary") ?? str(profile.about) ?? "",
    start: Number(tagValue(calendar.tags, "start")) || 0,
    end: Number(tagValue(calendar.tags, "end")) || undefined,
    location: tagValue(calendar.tags, "location") || undefined,
    icon: str(profile.picture),
    banner: tagValue(calendar.tags, "image") || str(profile.banner),
  };
}

function latest<T extends { id: string; created_at?: number }>(events: T[]): T | undefined {
  return pickLatest(events); // §3.1 tie-break, not arrival order (audit DS41-013)
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

/**
 * `base` is what the form was seeded with. When given, only the fields that
 * differ from it are taken from `input`; every other field comes from the
 * NEWEST 31923/kind-0 on the relays. Without it a stale Settings page on a
 * second device republished its whole snapshot and silently reverted fields
 * another device had saved since (e2e BUG-2, the 31923 twin of SB-87).
 */
export async function updateEventMetadata(
  ctx: EventContext,
  edited: EventMetadataInput,
  base?: EventMetadataInput,
): Promise<UpdateMetadataResult> {
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys || keys.role !== "organizer" || !keys.eidNsecHex) {
    throw new Error("organizer E_id key not available");
  }
  // See event-context: the coordinate names the kind.
  const { kind, pubkey, identifier } = parseCoordinate(ctx.coordinate);
  const [calendarEvents, profileEvents] = await Promise.all([
    fetchEvents(
      { kinds: [kind], authors: [pubkey], "#d": [identifier] },
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
  // Rebuild from the newest relay copy and apply only what the user changed.
  // No relay copy (unreadable, or a brand-new record): the form is all we have.
  let input = edited;
  if (base && priorCalendar) {
    const onRelays = metadataOnRelays(priorCalendar, profile);
    input = { ...onRelays };
    for (const field of METADATA_FIELDS) {
      if (edited[field] !== base[field]) (input as Record<MetadataField, unknown>)[field] = edited[field];
    }
    if (!input.start) input.start = edited.start;
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
      // The coordinate's own kind, not the calendar one: republishing a
      // community's metadata as 31923 would mint a SECOND record under a
      // different coordinate and orphan the community from everything that
      // points at it.
      kind,
      author: pubkey,
      identifier,
      relays: ctx.config.relays,
      owner: pubkey,
      sign: (created_at) =>
        finalizeEvent(
          { kind, created_at, tags, content: input.summary },
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
