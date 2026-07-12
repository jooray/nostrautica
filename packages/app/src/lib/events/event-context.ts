/**
 * Load an event's public surface (kind 31600 config + kind 31923 details) from
 * its naddr, and add the event's home relays to the pool. This is what every
 * event page needs before it can do anything else.
 */
import {
  KIND_EVENT_CONFIG,
  KIND_CALENDAR_EVENT,
  KIND_PROFILE,
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
  icon?: string; // small event logo (E_id kind-0 picture)
  banner?: string; // wide banner (31923 image / kind-0 banner)
  location?: string;
  hashtags: string[];
}

function tag(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

export async function loadEventContext(naddr: string): Promise<EventContext> {
  let decoded: { coordinate: string; relays: string[] };
  try {
    decoded = naddrToCoordinate(naddr);
  } catch (e) {
    console.error("Bad event address:", JSON.stringify(naddr), e);
    throw new Error("This event link looks invalid. Please reopen it from your invite or events list.");
  }
  const { coordinate, relays } = decoded;
  if (relays.length) addRelays(relays);
  const { pubkey, identifier } = parseCoordinate(coordinate);

  const [configEvents, eventEvents, profileEvents] = await Promise.all([
    fetchEvents({ kinds: [KIND_EVENT_CONFIG], authors: [pubkey], "#d": [identifier] }),
    fetchEvents({ kinds: [KIND_CALENDAR_EVENT], authors: [pubkey], "#d": [identifier] }),
    fetchEvents({ kinds: [KIND_PROFILE], authors: [pubkey] }),
  ]);

  const configEvent = configEvents.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  if (!configEvent) throw new Error("Event config (31600) not found");
  const config = parseEventConfig(pubkey, configEvent.tags);
  // Pull in the event's own home relays for subsequent operations.
  if (config.relays.length) addRelays(config.relays);

  // E_id's kind-0 carries the small icon (picture) and, as a fallback, the banner.
  const profileEvent = profileEvents.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  let kind0: Record<string, any> = {};
  if (profileEvent) {
    try {
      kind0 = JSON.parse(profileEvent.content);
    } catch {
      kind0 = {};
    }
  }

  const evt = eventEvents.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  return {
    naddr,
    coordinate,
    config,
    title: (evt && tag(evt.tags, "title")) ?? kind0.name ?? "Untitled event",
    summary: (evt && tag(evt.tags, "summary")) ?? kind0.about ?? "",
    start: evt ? Number(tag(evt.tags, "start")) || undefined : undefined,
    end: evt ? Number(tag(evt.tags, "end")) || undefined : undefined,
    icon: kind0.picture || undefined,
    banner: (evt && tag(evt.tags, "image")) || kind0.banner || undefined,
    location: evt ? tag(evt.tags, "location") : undefined,
    hashtags: evt ? evt.tags.filter((t) => t[0] === "t").map((t) => t[1]!) : [],
  };
}
