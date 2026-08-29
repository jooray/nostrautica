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
  pickLatest,
} from "@nostrautica/protocol";
import { fetchEvents, addRelays } from "$lib/nostr/ndk.js";
import { onlyVerified } from "$lib/nostr/verify.js";
import { i18n, t } from "$lib/i18n/i18n.svelte.js";
import { cacheGet, cacheSet, ANON } from "$lib/cache/persist.js";
import { swr } from "$lib/cache/swr.js";
import { session } from "$lib/signer/session.svelte.js";

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
  /** created_at of the 31600 config event — the latest-wins stamp for the cache. */
  configAt?: number;
  /** Newest created_at across the public events that make up this context. */
  contextAt?: number;
}

function tag(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

// The event context is public (kind 31600 + 31923 + E_id kind-0), so it's cached
// under the anon scope and now SURVIVES RELOADS (CACHING-PLAN §2.1) — navigating
// into any event sub-page paints instantly instead of awaiting a relay round-trip.
function ctxKey(naddr: string): string {
  return `ctx:${naddr}`;
}

// Coordinate → the event's home relays, recorded whenever a context is loaded
// (audit APPK-5): grant authentication (attendee.ts fetchEventConfig) runs
// without an event page open and would otherwise only know DEFAULT_RELAYS, so a
// custom-relay event's 31600 could never be fetched. Anon scope (public data).
function relayHintsKey(coordinate: string): string {
  return `relayhints:${coordinate}`;
}

/** The event's home relays as last seen, or [] when never recorded. */
export function eventRelayHints(coordinate: string): string[] {
  return cacheGet<string[]>(relayHintsKey(coordinate), ANON)?.data ?? [];
}

/** The already-loaded context for an naddr, if any (no network). */
export function cachedEventContext(naddr: string): EventContext | undefined {
  return cacheGet<EventContext>(ctxKey(naddr), ANON)?.data;
}

/**
 * SWR wrapper (§2.1): paint the cached context synchronously via `apply`, then
 * refresh from relays in the background and `apply` the fresh one. Crucially,
 * re-add the cached config's home relays SYNCHRONOUSLY so subsequent fetches
 * (roster, posts, …) target the right relays without waiting for the 31600
 * re-fetch. Returns the fresh (or cached) context for await-style callers.
 */
export async function ensureEventContext(
  naddr: string,
  apply: (ctx: EventContext, source: "cache" | "network") => void,
): Promise<EventContext | undefined> {
  const cached = cachedEventContext(naddr);
  if (cached?.config.relays.length) addRelays(cached.config.relays);
  return swr<EventContext>(
    ctxKey(naddr),
    () => loadEventContext(naddr),
    (ctx, source) => apply(ctx, source),
    { scope: ANON, atOf: (c) => c.contextAt ?? c.configAt ?? 0 },
  );
}

export async function loadEventContext(
  naddr: string,
  opts: { adoptLang?: boolean } = {},
): Promise<EventContext> {
  if (!naddr || naddr === "undefined" || naddr === "null") {
    throw new Error(t("error.badEventLink"));
  }
  let decoded: { coordinate: string; relays: string[] };
  try {
    decoded = naddrToCoordinate(naddr);
  } catch (e) {
    console.error("Bad event address:", JSON.stringify(naddr), e);
    throw new Error(t("error.badEventLink"));
  }
  const { coordinate, relays } = decoded;
  if (relays.length) addRelays(relays);
  const { pubkey, identifier } = parseCoordinate(coordinate);

  // Authority boundary (audit APPK-1): these fetches feed latest-by-created_at
  // picks the whole app trusts, so every candidate is signature-re-verified
  // here even though NDK already validates relay traffic.
  const [configEvents, eventEvents, profileEvents] = await Promise.all([
    fetchEvents({ kinds: [KIND_EVENT_CONFIG], authors: [pubkey], "#d": [identifier] }).then(onlyVerified),
    fetchEvents({ kinds: [KIND_CALENDAR_EVENT], authors: [pubkey], "#d": [identifier] }).then(onlyVerified),
    fetchEvents({ kinds: [KIND_PROFILE], authors: [pubkey] }).then(onlyVerified),
  ]);

  const configEvent = pickLatest(configEvents);
  if (!configEvent) throw new Error("Event config (31600) not found");
  const config = parseEventConfig(pubkey, configEvent.tags);
  // Pull in the event's own home relays for subsequent operations.
  if (config.relays.length) addRelays(config.relays);
  // Record the home relays for relay-less contexts (grant authentication, §8).
  if (config.relays.length) {
    cacheSet(relayHintsKey(coordinate), config.relays, configEvent.created_at ?? 0, ANON);
  }
  // The UI follows the event's language for this session unless the user has made
  // an explicit choice in Settings (spec §7.1). Cached-context re-entry is fine —
  // adoptEventLang is a no-op once an explicit choice exists. Background
  // prefetches pass adoptLang:false: warming another event's cache must not
  // switch the UI language mid-page. Logged-in accounts are excluded too — this
  // is an onboarding nicety for someone arriving cold off an invite link, not a
  // standing rule that browsing any event retunes an established account's UI.
  //
  // This is now the FALLBACK path, not the main one: an invite link carries the
  // language itself (`&lang=`, organizer.ts) and i18n.init() applies it before
  // the first paint and remembers it. What is left for this call is the case
  // where no link was involved — a bare nsec pasted into the join form, or
  // simply opening an event — which is exactly why it stays session-only.
  if (opts.adoptLang !== false && !session.loggedIn) i18n.adoptEventLang(config.lang);

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
  const ctx: EventContext = {
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
    configAt: configEvent.created_at,
    contextAt: Math.max(
      configEvent.created_at ?? 0,
      evt?.created_at ?? 0,
      profileEvent?.created_at ?? 0,
    ),
  };
  // Write-through to the persistent anon cache (§2.1); latest-wins on the config
  // event's created_at so a background refresh never regresses to an older config.
  cacheSet(ctxKey(naddr), ctx, ctx.contextAt ?? ctx.configAt ?? 0, ANON);
  return ctx;
}

/** Write an organizer-published metadata edit through to the public context cache. */
export function cacheEventContext(ctx: EventContext, at: number): void {
  cacheSet(ctxKey(ctx.naddr), { ...ctx, contextAt: at }, at, ANON);
}
