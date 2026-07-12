/**
 * Load an event's public surface (kind 31600 config + kind 31923 details) from
 * its naddr, and add the event's home relays to the pool. This is what every
 * event page needs before it can do anything else.
 */
import {
  KIND_EVENT_CONFIG,
  KIND_CALENDAR_EVENT,
  parseEventConfig,
  naddrToCoordinate,
  parseCoordinate,
  type EventConfig,
} from "@nostrautica/protocol";
import { fetchEvents, addRelays } from "$lib/nostr/ndk.js";

export interface EventContext {
  naddr: string;
  coordinate: string;
  config: EventConfig;
  title: string;
  summary: string;
  start?: number;
  end?: number;
  image?: string;
  location?: string;
  hashtags: string[];
}

function tag(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

export async function loadEventContext(naddr: string): Promise<EventContext> {
  const { coordinate, relays } = naddrToCoordinate(naddr);
  if (relays.length) addRelays(relays);
  const { pubkey, identifier } = parseCoordinate(coordinate);

  const [configEvents, eventEvents] = await Promise.all([
    fetchEvents({ kinds: [KIND_EVENT_CONFIG], authors: [pubkey], "#d": [identifier] }),
    fetchEvents({ kinds: [KIND_CALENDAR_EVENT], authors: [pubkey], "#d": [identifier] }),
  ]);

  const configEvent = configEvents.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  if (!configEvent) throw new Error("Event config (31600) not found");
  const config = parseEventConfig(pubkey, configEvent.tags);
  // Pull in the event's own home relays for subsequent operations.
  if (config.relays.length) addRelays(config.relays);

  const evt = eventEvents.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  return {
    naddr,
    coordinate,
    config,
    title: (evt && tag(evt.tags, "title")) ?? "Untitled event",
    summary: (evt && tag(evt.tags, "summary")) ?? "",
    start: evt ? Number(tag(evt.tags, "start")) || undefined : undefined,
    end: evt ? Number(tag(evt.tags, "end")) || undefined : undefined,
    image: evt ? tag(evt.tags, "image") : undefined,
    location: evt ? tag(evt.tags, "location") : undefined,
    hashtags: evt ? evt.tags.filter((t) => t[0] === "t").map((t) => t[1]!) : [],
  };
}
