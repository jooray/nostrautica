/**
 * Attendee-side flows (spec §8). Receive ECK grants (21602), then decrypt the
 * roster (31604) and per-attendee directory entries (31603) — all under the ECK,
 * addressed by blinded d's the attendee can now compute.
 */
import {
  KIND_GIFT_WRAP,
  KIND_KEY_GRANT,
  KIND_ORGANIZER_GRANT,
  KIND_EVENT_CONFIG,
  KIND_CALENDAR_EVENT,
  KIND_DIRECTORY_ENTRY,
  KIND_ROSTER,
  KIND_MATCH_LIST,
  giftwrapSince,
  eckDecrypt,
  base64ToBytes,
  hexToBytes,
  blindedD,
  keyGrantContentSchema,
  organizerGrantContentSchema,
  directoryEntryContentSchema,
  rosterContentSchema,
  matchListContentSchema,
  parseCoordinate,
  parseEventConfig,
  type DirectoryEntryContent,
  type RosterContent,
  type MatchListContent,
  type KeyGrantContent,
  type OrganizerGrantContent,
  type EventConfig,
  type Rumor,
} from "@nostrautica/protocol";
import type { GiftWrap } from "@nostrautica/protocol";
import { getPublicKey } from "nostr-tools/pure";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "./event-context.js";
import { signerUnwrap } from "./giftwrap.js";
import { addEckVersions, loadEventKeys, currentEck, saveEventKeys } from "./keystore.js";
import { directoryPublisher } from "./organizer.js";
import { fetchEvents, fetchEventsRelayOnly } from "$lib/nostr/ndk.js";
import { streamEvents, type StreamHandle } from "$lib/nostr/stream.js";
import { DEFAULT_RELAYS } from "$lib/nostr/relays.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

/**
 * Authenticate a received 21605 Organizer Grant (spec §8, audit finding C2).
 *
 * The seal author is bound to `rumor.pubkey` by `signerUnwrap` (NIP-59 rumor/seal
 * author binding), so `rumor.pubkey` is the cryptographically verified authority
 * that sealed this grant. A genuine organizer grant is sealed by the event's E_id
 * (= the coordinate's pubkey), names E_id as the granter, and carries custody
 * secrets that derive exactly E_id and the event's declared inbox key. Anyone else
 * (a random Nostr key claiming to be E_id) is rejected: they can't seal as E_id.
 *
 * `config` is the event's parsed, signed 31600. When it can't be fetched the E_id
 * authority + `eid_nsec` derivation are still enforced; the inbox check is skipped.
 */
export function authenticateOrganizerGrant(
  rumor: Rumor,
  grant: OrganizerGrantContent,
  config: EventConfig | undefined,
): boolean {
  let coord;
  try {
    coord = parseCoordinate(grant.a);
  } catch {
    return false;
  }
  if (coord.kind !== KIND_CALENDAR_EVENT) return false;
  const eid = coord.pubkey;
  // Must be sealed by E_id itself, and name E_id as the granting authority.
  if (rumor.pubkey !== eid) return false;
  if (grant.granted_by !== rumor.pubkey) return false;
  // Custody secrets must derive exactly E_id (and the declared inbox, if known).
  try {
    if (getPublicKey(hexToBytes(grant.eid_nsec)) !== eid) return false;
    const einboxPk = getPublicKey(hexToBytes(grant.einbox_nsec));
    if (config && einboxPk !== config.inbox) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Authenticate a received 21602 Key Grant (audit finding C2).
 *
 * A genuine key grant is sealed either by the event's E_id (= the coordinate's
 * pubkey) or by the event's currently configured coordinator, and names that same
 * author as the granter. `rumor.pubkey` is the verified seal author (see
 * `authenticateOrganizerGrant`). The event's signed 31600 `config` is required to
 * identify the configured coordinator; without it the authority can't be
 * established and the grant is rejected.
 */
export function authenticateKeyGrant(
  rumor: Rumor,
  grant: KeyGrantContent,
  config: EventConfig | undefined,
): boolean {
  let coord;
  try {
    coord = parseCoordinate(grant.a);
  } catch {
    return false;
  }
  if (coord.kind !== KIND_CALENDAR_EVENT) return false;
  if (!config) return false;
  const eid = coord.pubkey;
  const author = rumor.pubkey;
  const authorized = author === eid || (!!config.coordinator && author === config.coordinator);
  if (!authorized) return false;
  if (grant.granted_by !== author) return false;
  return true;
}

/** Fetch and parse the latest signed 31600 config for an event coordinate. */
async function fetchEventConfig(coordinate: string): Promise<EventConfig | undefined> {
  let coord;
  try {
    coord = parseCoordinate(coordinate);
  } catch {
    return undefined;
  }
  const events = await fetchEvents(
    { kinds: [KIND_EVENT_CONFIG], authors: [coord.pubkey], "#d": [coord.identifier] },
    DEFAULT_RELAYS,
  );
  const latest = events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  if (!latest) return undefined;
  try {
    return parseEventConfig(coord.pubkey, latest.tags);
  } catch {
    return undefined;
  }
}

/** Per-identity marker: has a full-history grant backfill run on this device? */
function grantsBackfilledKey(pubkey: string): string {
  return `nostrautica-grants-backfilled:${pubkey}`;
}
function hasBackfilledGrants(pubkey: string): boolean {
  try {
    return localStorage.getItem(grantsBackfilledKey(pubkey)) === "1";
  } catch {
    return false;
  }
}
function markGrantsBackfilled(pubkey: string): void {
  try {
    localStorage.setItem(grantsBackfilledKey(pubkey), "1");
  } catch {
    /* storage unavailable — a full backfill just re-runs next load */
  }
}

/**
 * Scan for ECK grants addressed to the user and fold them into the local key
 * store. Returns the coordinates the user now holds a key for.
 *
 * Every grant is authenticated before it can mutate local key custody (audit
 * finding C2): a forged grant sealed by an arbitrary Nostr key claiming to be the
 * event's E_id/coordinator is ignored, so an attacker can't poison local state
 * with attacker-chosen keys or fabricate administration/approval.
 *
 * Recovery window (audit finding H2): on the FIRST grant scan for this identity on
 * this device (a fresh install or a restored identity), backfill the full
 * gift-wrap history (since 0) so an ECK grant published longer than the
 * steady-state window ago — e.g. an event joined weeks earlier — is not missed on
 * a clean device. Later scans use the narrow live-overlap window. This mirrors the
 * coordinator's fresh-install vs. recent backfill.
 */
export async function receiveGrants(signer: AppSigner): Promise<string[]> {
  const pubkey = await signer.getPublicKey();
  const fullBackfill = !hasBackfilledGrants(pubkey);
  // Relay-only read (no dexie cache in the loop): grants must not be missed —
  // fetchEvents can EOSE-resolve before the cache adapter surfaces a wrap that
  // already arrived from the relay (found via e2e, TEST-REPORT-2026-07-13).
  // Explicit relay set: without one, NDK's outbox calculation can stall the
  // fetch indefinitely when relay lists are unresolvable (BUG-1b).
  const wraps = (await fetchEventsRelayOnly(
    {
      kinds: [KIND_GIFT_WRAP],
      "#p": [pubkey],
      since: fullBackfill ? 0 : giftwrapSince(),
    },
    DEFAULT_RELAYS,
  )) as unknown as GiftWrap[];

  const coordinates = new Set<string>();
  // Per-wrap unwrap memo (CACHING-PLAN §2.3), owner-scoped, persisted: a wrap we
  // have ALREADY unwrapped once never needs `signerUnwrap` again on a re-scan —
  // the #1 Amber/NIP-46 prompt/latency saver. The relay-only fetch above still
  // runs every time (HARD CONSTRAINT 1: must-not-miss semantics untouched); this
  // only skips the redundant per-wrap signer round-trip. Transient unwrap
  // failures are NOT memoized, so a real grant that failed to decrypt is retried.
  const memo: Record<string, true> = { ...(cacheGet<Record<string, true>>("grantwraps")?.data ?? {}) };
  let memoDirty = false;
  // Cache the (network-fetched) signed 31600 per coordinate so multiple grants
  // for one event only cost a single config lookup.
  const configCache = new Map<string, EventConfig | undefined>();
  const configFor = async (coordinate: string): Promise<EventConfig | undefined> => {
    if (!configCache.has(coordinate)) {
      configCache.set(coordinate, await fetchEventConfig(coordinate));
    }
    return configCache.get(coordinate);
  };

  for (const wrap of wraps) {
    // Recipient binding: the relay filter already restricts `#p`, but a hostile
    // relay can return extra wraps — the successful unwrap below proves the wrap
    // was actually sealed to us, this is just a cheap early guard.
    if (!wrap.tags.some((tg) => tg[0] === "p" && tg[1] === pubkey)) continue;
    // Already unwrapped in a prior scan/session — skip the signer round-trip.
    if (memo[wrap.id]) continue;
    let rumor;
    try {
      rumor = await signerUnwrap(signer, wrap);
    } catch {
      continue; // transient/foreign — NOT memoized, retried next scan
    }
    // Successfully unwrapped: never signer-decrypt this wrap again.
    memo[wrap.id] = true;
    memoDirty = true;
    if (rumor.kind === KIND_ORGANIZER_GRANT) {
      // Co-organizer custody: store the full event keys so this device can admin.
      let grant;
      try {
        grant = organizerGrantContentSchema.parse(JSON.parse(rumor.content));
      } catch {
        continue; /* malformed */
      }
      const config = await configFor(grant.a);
      if (!authenticateOrganizerGrant(rumor, grant, config)) {
        console.warn(
          "[receiveGrants] ignored forged/invalid organizer grant (21605) for",
          grant.a,
        );
        continue;
      }
      await saveEventKeys({
        coordinate: grant.a,
        role: "organizer",
        eck: grant.eck,
        eidNsecHex: grant.eid_nsec,
        einboxNsecHex: grant.einbox_nsec,
      });
      coordinates.add(grant.a);
      continue;
    }
    if (rumor.kind !== KIND_KEY_GRANT) continue;
    let grant;
    try {
      grant = keyGrantContentSchema.parse(JSON.parse(rumor.content));
    } catch {
      continue;
    }
    const config = await configFor(grant.a);
    if (!authenticateKeyGrant(rumor, grant, config)) {
      console.warn(
        "[receiveGrants] ignored forged/invalid key grant (21602) for",
        grant.a,
      );
      continue;
    }
    await addEckVersions(
      grant.a,
      grant.eck,
      grant.role === "organizer" ? "organizer" : "attendee",
    );
    coordinates.add(grant.a);
  }
  // The full-history scan completed without throwing (a fetch failure would have
  // rejected above), so later scans can safely narrow to the live-overlap window.
  if (fullBackfill) markGrantsBackfilled(pubkey);
  if (memoDirty) cacheSet("grantwraps", memo, Math.floor(Date.now() / 1000));
  return [...coordinates];
}

/** True if the user holds an ECK for this event (i.e. is approved). */
export async function isApproved(coordinate: string): Promise<boolean> {
  const keys = await loadEventKeys(coordinate);
  return !!currentEck(keys);
}

async function eckBytesFor(coordinate: string): Promise<Uint8Array | undefined> {
  const keys = await loadEventKeys(coordinate);
  const eck = currentEck(keys);
  return eck ? base64ToBytes(eck.key) : undefined;
}

// Decrypted roster/directory/matches are member-only (ECK/nip44), so they cache
// under the OWNER scope and now survive reloads (CACHING-PLAN §2.3) — wiped on
// logout by clearOwnerCache. Keyed per coordinate.
function rosterKey(coordinate: string): string {
  return `roster:${coordinate}`;
}
function dirKey(coordinate: string): string {
  return `dir:${coordinate}`;
}
function matchesKey(coordinate: string): string {
  return `matches:${coordinate}`;
}

/** Cached decrypted roster for a coordinate (no network), or undefined. */
export function cachedRoster(coordinate: string): RosterContent | undefined {
  return cacheGet<RosterContent>(rosterKey(coordinate))?.data;
}

/** Fetch + decrypt the roster. Returns undefined if the user isn't approved. */
export async function fetchRoster(ctx: EventContext): Promise<RosterContent | undefined> {
  const eck = await eckBytesFor(ctx.coordinate);
  if (!eck) return undefined;
  const publisher = directoryPublisher(ctx);
  const { identifier } = parseCoordinate(ctx.coordinate);
  // Streamed one-shot: first EOSE + grace instead of the slowest relay — this
  // read gates the whole People screen ("Decrypting the roster…").
  const events = await streamEvents(
    { kinds: [KIND_ROSTER], authors: [publisher], "#d": [identifier] },
    { relays: ctx.config.relays },
  ).ready;
  const latest = events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  if (!latest) return { v: 1, eck_current: 1, attendees: [] };
  try {
    const roster = rosterContentSchema.parse(JSON.parse(eckDecrypt(eck, latest.content)));
    cacheSet(rosterKey(ctx.coordinate), roster, latest.created_at ?? 0);
    return roster;
  } catch {
    return undefined;
  }
}

// The decrypted directory entries survive reloads too (owner-scoped) so the
// attendee-detail page paints one person instantly and the People list paints
// its last snapshot before the roster stream even opens.
function cacheDirectory(coordinate: string, entries: DirectoryEntryContent[], at?: number): void {
  cacheSet(dirKey(coordinate), entries, at);
}

/** All cached directory entries for a coordinate (no network), or undefined. */
export function cachedDirectory(coordinate: string): DirectoryEntryContent[] | undefined {
  return cacheGet<DirectoryEntryContent[]>(dirKey(coordinate))?.data;
}
/** One cached directory entry by pubkey (no network), or undefined. */
export function cachedDirectoryEntry(
  coordinate: string,
  pubkey: string,
): DirectoryEntryContent | undefined {
  return cachedDirectory(coordinate)?.find((e) => e.pubkey === pubkey);
}

/** Fetch + decrypt every directory entry listed in the roster. */
export async function fetchDirectory(
  ctx: EventContext,
): Promise<DirectoryEntryContent[]> {
  const eck = await eckBytesFor(ctx.coordinate);
  if (!eck) return [];
  const roster = await fetchRoster(ctx);
  if (!roster || roster.attendees.length === 0) return [];

  const publisher = directoryPublisher(ctx);
  const ds = roster.attendees.map((a) => a.d);
  const events = await streamEvents(
    { kinds: [KIND_DIRECTORY_ENTRY], authors: [publisher], "#d": ds },
    { relays: ctx.config.relays },
  ).ready;
  // Keep the latest event per blinded d.
  const latestByD = new Map<string, (typeof events)[number]>();
  for (const e of events) {
    const d = e.tags.find((t) => t[0] === "d")?.[1];
    if (!d) continue;
    const prev = latestByD.get(d);
    if (!prev || (e.created_at ?? 0) > (prev.created_at ?? 0)) latestByD.set(d, e);
  }

  const entries: DirectoryEntryContent[] = [];
  let newestAt = 0;
  for (const e of latestByD.values()) {
    try {
      entries.push(directoryEntryContentSchema.parse(JSON.parse(eckDecrypt(eck, e.content))));
      if ((e.created_at ?? 0) > newestAt) newestAt = e.created_at ?? 0;
    } catch {
      /* skip entries we can't decrypt (e.g. published under a newer ECK) */
    }
  }
  cacheDirectory(ctx.coordinate, entries, newestAt);
  return entries;
}

export interface DirectoryStream {
  /** Settles at first-EOSE+grace or timeout with everything decrypted so far. */
  ready: Promise<DirectoryEntryContent[]>;
  stop: () => void;
}

/**
 * Progressive variant of `fetchDirectory`: decrypted entries reach `onEntries`
 * (full snapshot, latest per blinded d) as relays answer, so the roster renders
 * without waiting for the slowest relay. Batched on a short timer so a burst of
 * events doesn't re-sort the UI per event. Signer-free: the ECK comes from the
 * keystore. Returns undefined when the user isn't approved or the roster is
 * empty — same cases where `fetchDirectory` returns [].
 */
export async function streamDirectory(
  ctx: EventContext,
  onEntries: (entries: DirectoryEntryContent[]) => void,
): Promise<DirectoryStream | undefined> {
  const eck = await eckBytesFor(ctx.coordinate);
  if (!eck) return undefined; // not approved — nothing decryptable
  const publisher = directoryPublisher(ctx);
  const coord = ctx.coordinate;

  // Accumulate by PUBKEY (one entry per attendee), latest-wins by created_at, so
  // we can seed from the cached snapshot and a background refresh never flashes
  // the list down to fewer people (CACHING-PLAN §2.3, §3.4).
  const byPk = new Map<string, { entry: DirectoryEntryContent; at: number }>();
  const cached = cachedDirectory(coord);
  if (cached) for (const e of cached) byPk.set(e.pubkey, { entry: e, at: 0 });
  const snapshot = () => [...byPk.values()].map((v) => v.entry);
  let newestAt = 0;

  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    flushTimer = undefined;
    const snap = snapshot();
    cacheDirectory(coord, snap, newestAt); // write-through the decrypted snapshot
    onEntries(snap);
  };
  const scheduleFlush = () => {
    if (!flushTimer) flushTimer = setTimeout(flush, 60);
  };

  const onDirEvent = (e: { tags: string[][]; content: string; created_at?: number }) => {
    if (!e.tags.some((tg) => tg[0] === "d")) return;
    const at = e.created_at ?? 0;
    try {
      const entry = directoryEntryContentSchema.parse(JSON.parse(eckDecrypt(eck, e.content)));
      const prev = byPk.get(entry.pubkey);
      if (!prev || at >= prev.at) byPk.set(entry.pubkey, { entry, at });
      if (at > newestAt) newestAt = at;
      scheduleFlush();
    } catch {
      /* skip entries we can't decrypt (e.g. published under a newer ECK) */
    }
  };

  // Paint whatever we already have, instantly.
  if (byPk.size) onEntries(snapshot());

  // (Re)start the entry stream over a blinded-d list; restarts when the fresh
  // roster changes the set. Entries accumulate into the same byPk map.
  let inner: StreamHandle | undefined;
  let currentDs: string[] = [];
  const startStream = (ds: string[]): StreamHandle => {
    inner?.stop();
    currentDs = ds;
    inner = streamEvents(
      { kinds: [KIND_DIRECTORY_ENTRY], authors: [publisher], "#d": ds },
      { relays: ctx.config.relays, onEvent: onDirEvent },
    );
    return inner;
  };
  const dsChanged = (ds: string[]): boolean =>
    ds.length > 0 &&
    (ds.length !== currentDs.length || ds.some((d) => !currentDs.includes(d)));

  let resolveReady!: (v: DirectoryEntryContent[]) => void;
  const ready = new Promise<DirectoryEntryContent[]>((r) => (resolveReady = r));
  const settle = (h: StreamHandle | undefined) => {
    if (!h) return resolveReady(snapshot());
    void h.ready.then(() => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flush();
      }
      resolveReady(snapshot());
    });
  };

  // Refresh the roster from relays in the background; if its blinded-d set
  // changed, restart the entry stream over the new set (§2.3 step 2).
  const refreshRoster = async () => {
    const fresh = await fetchRoster(ctx).catch(() => undefined);
    if (fresh && dsChanged(fresh.attendees.map((a) => a.d))) {
      const h = startStream(fresh.attendees.map((a) => a.d));
      void h.ready.then(() => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flush();
        }
      });
    }
  };

  const cachedR = cachedRoster(coord);
  if (cachedR && cachedR.attendees.length) {
    // Warm: don't await fetchRoster — stream the cached d's now, refresh in parallel.
    settle(startStream(cachedR.attendees.map((a) => a.d)));
    void refreshRoster();
  } else {
    // Cold: must await the fresh roster before we know which d's to stream.
    void (async () => {
      const fresh = await fetchRoster(ctx).catch(() => undefined);
      if (!fresh || fresh.attendees.length === 0) return settle(undefined);
      settle(startStream(fresh.attendees.map((a) => a.d)));
    })();
  }

  return {
    ready,
    stop: () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      inner?.stop();
    },
  };
}

/** Fetch + decrypt a single attendee's directory entry by pubkey. */
export async function fetchDirectoryEntry(
  ctx: EventContext,
  attendeePubkey: string,
): Promise<DirectoryEntryContent | undefined> {
  const all = await fetchDirectory(ctx);
  return all.find((e) => e.pubkey === attendeePubkey);
}

/**
 * Fetch + decrypt the signed-in attendee's own match list (kind 31605). The list
 * is NIP-44-encrypted coordinator→recipient, so only the recipient can read the
 * reasoning (spec §6.4). Returns undefined if there's no coordinator or no list.
 */
/** Cached decrypted match list for a coordinate (no network), or undefined. */
export function cachedMatches(coordinate: string): MatchListContent | undefined {
  return cacheGet<MatchListContent>(matchesKey(coordinate))?.data;
}

export async function fetchMatches(
  signer: AppSigner,
  ctx: EventContext,
): Promise<MatchListContent | undefined> {
  const coordinator = ctx.config.coordinator;
  if (!coordinator) return undefined;
  const eck = await eckBytesFor(ctx.coordinate);
  if (!eck) return undefined;
  const pubkey = await signer.getPublicKey();
  const d = blindedD(eck, ctx.coordinate, pubkey);
  const events = await streamEvents(
    { kinds: [KIND_MATCH_LIST], authors: [coordinator], "#d": [d] },
    { relays: ctx.config.relays },
  ).ready;
  const latest = events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  if (!latest) return undefined;
  try {
    const json = await signer.nip44Decrypt(coordinator, latest.content);
    const list = matchListContentSchema.parse(JSON.parse(json));
    // Persist the decrypted list (owner-scoped) so Matches paints instantly next
    // time (§2.3); latest-wins on the 31605's created_at.
    cacheSet(matchesKey(ctx.coordinate), list, latest.created_at ?? 0);
    return list;
  } catch {
    return undefined;
  }
}
