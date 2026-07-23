/** Organizer edits for the public NIP-52 event and its event-identity profile. */
import { finalizeEvent } from "nostr-tools/pure";
import {
  KIND_CALENDAR_EVENT,
  KIND_PROFILE,
  hexToBytes,
  parseCoordinate,
} from "@nostrautica/protocol";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";
import { onlyVerified } from "$lib/nostr/verify.js";
import { loadEventKeys } from "./keystore.js";
import { cacheEventContext, type EventContext } from "./event-context.js";

export interface EventMetadataInput {
  title: string;
  summary: string;
  start: number;
  end?: number;
  location?: string;
  icon?: string;
  banner?: string;
}

const MANAGED_TAGS = new Set(["title", "summary", "start", "end", "location", "image"]);

function latest<T extends { created_at?: number }>(events: T[]): T | undefined {
  return events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
}

/**
 * Republish the addressable 31923 and replaceable kind-0 under E_id. Unknown
 * NIP-52 tags are retained so editing in Nostrautica does not discard metadata
 * added by another calendar client.
 */
export async function updateEventMetadata(
  ctx: EventContext,
  input: EventMetadataInput,
): Promise<EventContext> {
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

  const now = Math.max(
    Math.floor(Date.now() / 1000),
    (ctx.contextAt ?? ctx.configAt ?? 0) + 1,
    (priorCalendar?.created_at ?? 0) + 1,
    (priorProfile?.created_at ?? 0) + 1,
  );
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
  if (input.summary) tags.push(["summary", input.summary]);
  if (input.banner) tags.push(["image", input.banner]);
  if (input.location) tags.push(["location", input.location]);

  const eidSk = hexToBytes(keys.eidNsecHex);
  const calendarEvent = finalizeEvent(
    {
      kind: KIND_CALENDAR_EVENT,
      created_at: now,
      tags,
      content: input.summary,
    },
    eidSk,
  );
  const profileEvent = finalizeEvent(
    {
      kind: KIND_PROFILE,
      created_at: now,
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
  );
  await Promise.all([
    publishOrQueue(calendarEvent, ctx.config.relays),
    publishOrQueue(profileEvent, ctx.config.relays),
  ]);

  const updated: EventContext = {
    ...ctx,
    title: input.title,
    summary: input.summary,
    start: input.start,
    end: input.end,
    location: input.location,
    icon: input.icon,
    banner: input.banner,
    contextAt: now,
  };
  cacheEventContext(updated, now);
  return updated;
}
