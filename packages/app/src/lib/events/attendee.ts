/**
 * Attendee-side flows (spec §8). Receive ECK grants (21602), then decrypt the
 * roster (31604) and per-attendee directory entries (31603) — all under the ECK,
 * addressed by blinded d's the attendee can now compute.
 */
import {
  KIND_GIFT_WRAP,
  KIND_KEY_GRANT,
  KIND_ORGANIZER_GRANT,
  KIND_COORDINATOR_STATUS,
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
  parsePayloadSafe,
  isNewerProtocolVersion,
  NewerProtocolVersionError,
  pickLatest,
  supersedes,
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
import { addEckVersions, applyOrganizerGrant, loadEventKeys, currentEck } from "./keystore.js";
import { acceptedRecordAuthors } from "./organizer.js";
import { fetchEvents, fetchEventsRelayOnly } from "$lib/nostr/ndk.js";
import { onlyVerified, onlyByAuthors } from "$lib/nostr/verify.js";
import { streamEvents, type StreamHandle, type StreamOptions } from "$lib/nostr/stream.js";
import { DEFAULT_RELAYS, unionRelays } from "$lib/nostr/relays.js";
import { eventRelayHints } from "./event-context.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";
import { updatePrompt } from "$lib/stores/update-prompt.svelte.js";
import { recordOwnStatus } from "./attendee-status.js";
import {
  startScanBudget,
  emptyOutcome,
  type ScanBudget,
  type ScanOutcome,
} from "./scan-budget.js";

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

/**
 * Fetch and parse the latest signed 31600 config for an event coordinate.
 * `relayHints` are the event's own relays when the caller knows them (audit
 * APPK-5): an event living on custom relays is unreachable via DEFAULT_RELAYS
 * alone, which used to make its grants permanently unauthenticatable. Hints
 * are unioned with the defaults, never trusted exclusively.
 */
async function fetchEventConfig(
  coordinate: string,
  relayHints: string[] = [],
): Promise<EventConfig | undefined> {
  let coord;
  try {
    coord = parseCoordinate(coordinate);
  } catch {
    return undefined;
  }
  const relays = unionRelays(relayHints, DEFAULT_RELAYS);
  const events = await fetchEvents(
    { kinds: [KIND_EVENT_CONFIG], authors: [coord.pubkey], "#d": [coord.identifier] },
    relays,
  );
  // Authority boundary (audit APPK-1): re-verify before the latest-wins pick.
  const latest = pickLatest(onlyVerified(events));
  if (!latest) return undefined;
  try {
    return parseEventConfig(coord.pubkey, latest.tags);
  } catch (e) {
    // The config is E_id-signed (onlyVerified + authored by coord.pubkey) — a
    // trusted authority. A newer protocol version here means this client is stale
    // (NIP §2 / D2): prompt an update instead of silently dropping the event.
    if (e instanceof NewerProtocolVersionError) updatePrompt.flag();
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
/** Cap on the persisted grant-wrap memo (audit App-7), mirroring the DM memo. */
export const MAX_GRANT_WRAPS = 5000;

export async function receiveGrants(
  signer: AppSigner,
  opts: { budget?: ScanBudget; onOutcome?: (outcome: ScanOutcome) => void } = {},
): Promise<string[]> {
  const pubkey = await signer.getPublicKey();
  // Bounded (see `scan-budget.ts`): every un-memoized wrap costs TWO signer
  // round trips (giftwrap.ts unwraps the wrap, then the seal), each with a 60s
  // ceiling on a remote signer and possibly a human approval dialog. Walking a
  // full-history backfill of them unbounded is the prompt storm behind the
  // 2026-07-28 "my events vanished" report. A truncated pass is reported rather
  // than swallowed, so the caller can distinguish it from an empty inbox.
  const budget = opts.budget ?? startScanBudget();
  const outcome = emptyOutcome();
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
  // Did this scan prove the SIGNER can actually read our wraps? A full-history
  // backfill that unwrapped nothing is not evidence there was nothing to find —
  // on a remote signer (Amber) every unwrap is two NIP-46 round trips, and a
  // signer that was unreachable/unapproved for the whole pass fails all of them
  // identically to "no grants here". Latching `markGrantsBackfilled` on that
  // narrows every later scan to `giftwrapSince()` (now − 3 days), so an ECK
  // grant from an event joined last month becomes PERMANENTLY undiscoverable on
  // this device. Mirrors the `meaningful` guard recover.ts already has.
  let unwrapped = 0;
  let unwrapFailed = 0;
  // Per-wrap memo (CACHING-PLAN §2.3), owner-scoped, persisted: a wrap whose
  // processing reached a DEFINITIVE outcome never needs `signerUnwrap` again on
  // a re-scan — the #1 Amber/NIP-46 prompt/latency saver. The relay-only fetch
  // above still runs every time (HARD CONSTRAINT 1: must-not-miss semantics
  // untouched). Memoization happens only AFTER the outcome is known (audit
  // APPK-5): a transient signer failure, or a 21602 whose 31600 config can't be
  // fetched right now, is NOT memoized, so the next scan retries it.
  const memo: Record<string, true> = { ...(cacheGet<Record<string, true>>("grantwraps")?.data ?? {}) };
  let memoDirty = false;
  // Cache the (network-fetched) signed 31600 per coordinate so multiple grants
  // for one event only cost a single config lookup.
  const configCache = new Map<string, EventConfig | undefined>();
  const configFor = async (
    coordinate: string,
    relayHints: string[] = [],
  ): Promise<EventConfig | undefined> => {
    if (!configCache.has(coordinate)) {
      // A fetch/relay failure is not a definitive "no config" — collapse it to
      // undefined (config-absent) so the caller treats the grant as retryable.
      configCache.set(
        coordinate,
        await fetchEventConfig(coordinate, relayHints).catch(() => undefined),
      );
    }
    return configCache.get(coordinate);
  };

  for (const wrap of wraps) {
    // Recipient binding: the relay filter already restricts `#p`, but a hostile
    // relay can return extra wraps — the successful unwrap below proves the wrap
    // was actually sealed to us, this is just a cheap early guard.
    if (!wrap.tags.some((tg) => tg[0] === "p" && tg[1] === pubkey)) continue;
    // Already definitively processed in a prior scan/session — skip the signer
    // round-trip.
    if (memo[wrap.id]) continue;
    // Out of time or out of prompts: stop rather than start another two-round-
    // trip unwrap. Everything decided so far is already memoized and the
    // full-history latch below is withheld, so the next scan resumes where this
    // one stopped — a truncated pass costs a retry, not a lost grant.
    if (!budget.take()) {
      outcome.truncated = true;
      break;
    }
    outcome.attempted++;
    let rumor;
    try {
      rumor = await signerUnwrap(signer, wrap);
      unwrapped++;
      outcome.succeeded++;
    } catch {
      unwrapFailed++;
      continue; // transient/foreign — NOT memoized, retried next scan
    }
    if (rumor.kind === KIND_ORGANIZER_GRANT) {
      // Co-organizer custody: store the full event keys so this device can admin.
      let grant;
      try {
        const raw = JSON.parse(rumor.content);
        // A grant sealed by the E_id/coordinator authority (rumor.pubkey is bound
        // by signerUnwrap) that carries a newer protocol version means this client
        // is stale (NIP §2 / D2) — prompt an update. Still definitive: memoize.
        if (isNewerProtocolVersion(raw)) updatePrompt.flag();
        grant = organizerGrantContentSchema.parse(raw);
      } catch {
        memo[wrap.id] = true; // malformed — definitive, never re-try
        memoDirty = true;
        continue;
      }
      const config = await configFor(grant.a, grant.config_relays);
      // authenticateOrganizerGrant enforces the E_id authority checks even when
      // the config is unavailable (it only widens the inbox check), so pass/fail
      // here is always a definitive outcome — safe to memoize either way.
      if (!authenticateOrganizerGrant(rumor, grant, config)) {
        console.warn(
          "[receiveGrants] ignored forged/invalid organizer grant (21605) for",
          grant.a,
        );
        memo[wrap.id] = true;
        memoDirty = true;
        continue;
      }
      // Union the granted ECK versions into any existing record (audit APPK-4):
      // an authentic-but-stale 21605 processed after a fresher 21602 must not
      // clobber the record back to older versions — only role/secrets update.
      await applyOrganizerGrant(grant.a, {
        eck: grant.eck,
        eidNsecHex: grant.eid_nsec,
        einboxNsecHex: grant.einbox_nsec,
      });
      coordinates.add(grant.a);
      memo[wrap.id] = true;
      memoDirty = true;
      continue;
    }
    if (rumor.kind === KIND_KEY_GRANT) {
      let grant;
      try {
        const raw = JSON.parse(rumor.content);
        // Newer-protocol grant from the authenticated E_id/coordinator authority:
        // prompt an update (NIP §2 / D2) before dropping it.
        if (isNewerProtocolVersion(raw)) updatePrompt.flag();
        grant = keyGrantContentSchema.parse(raw);
      } catch {
        memo[wrap.id] = true; // malformed — definitive
        memoDirty = true;
        continue;
      }
      const config = await configFor(grant.a, eventRelayHints(grant.a));
      if (!config) {
        // The event's signed 31600 isn't fetchable right now (transient relay
        // gap, or an event living on relays we haven't recorded yet), and
        // authenticateKeyGrant can't establish the granting authority without
        // it. This is NOT a definitive negative — leave the wrap un-memoized so
        // the next scan retries (audit APPK-5).
        continue;
      }
      if (!authenticateKeyGrant(rumor, grant, config)) {
        console.warn(
          "[receiveGrants] ignored forged/invalid key grant (21602) for",
          grant.a,
        );
        // Definitive negative WITH a successfully fetched config — memoize.
        memo[wrap.id] = true;
        memoDirty = true;
        continue;
      }
      await addEckVersions(
        grant.a,
        grant.eck,
        grant.role === "organizer" ? "organizer" : "attendee",
      );
      coordinates.add(grant.a);
      memo[wrap.id] = true;
      memoDirty = true;
      continue;
    }
    // Own coordinator status (21606 sealed to this attendee, NIP §6.3): a failure
    // in THIS attendee's own submission/talk pipeline. Authenticate against the
    // event's configured coordinator and record it for the modest in-app banner.
    if (rumor.kind === KIND_COORDINATOR_STATUS) {
      let coord: string | undefined;
      try {
        coord = (JSON.parse(rumor.content) as { a?: string }).a;
      } catch {
        /* malformed — still memoize below */
      }
      const config = coord ? await configFor(coord, eventRelayHints(coord)) : undefined;
      recordOwnStatus(rumor, pubkey, config?.coordinator);
      memo[wrap.id] = true;
      memoDirty = true;
      continue;
    }
    // Any other successfully-unwrapped wrap (a DM, a chat welcome, …) is not a
    // grant — definitively not this scanner's business, so memoize it and never
    // spend a signer round-trip on it here again.
    memo[wrap.id] = true;
    memoDirty = true;
  }
  // The full-history scan completed without throwing (a fetch failure would have
  // rejected above), ran to the end of the wrap list rather than out of budget,
  // AND was meaningful: either there was nothing addressed to us to unwrap, or
  // the signer successfully unwrapped at least one wrap. A pass where every
  // single unwrap failed is a signer/transport outage, not an empty inbox —
  // leave the marker unset so the next scan re-runs the full history.
  if (fullBackfill && !outcome.truncated && (unwrapped > 0 || unwrapFailed === 0)) {
    markGrantsBackfilled(pubkey);
  }
  if (memoDirty) {
    // Bound the memo (audit App-7): unlike the DM memo this had no cap, so it
    // grew one entry per gift wrap ever seen (grants AND every skipped DM/chat
    // welcome) and never aged. Evict oldest-inserted entries past the cap — a
    // re-encountered wrap just costs one extra signer unwrap next scan (a perf
    // cost, never a correctness one), mirroring the DM memo's 3000-cap policy.
    const keys = Object.keys(memo);
    if (keys.length > MAX_GRANT_WRAPS) {
      const keep = new Set(keys.slice(-MAX_GRANT_WRAPS));
      for (const k of keys) if (!keep.has(k)) delete memo[k];
    }
    cacheSet("grantwraps", memo, Math.floor(Date.now() / 1000));
  }
  // Report only on the success path: a throw above reaches the caller as a
  // rejection, which is a strictly more specific signal than this outcome.
  opts.onOutcome?.(outcome);
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
  const authors = acceptedRecordAuthors(ctx);
  const { identifier } = parseCoordinate(ctx.coordinate);
  // Streamed one-shot: first EOSE + grace instead of the slowest relay — this
  // read gates the whole People screen ("Decrypting the roster…").
  const events = await streamEvents(
    { kinds: [KIND_ROSTER], authors, "#d": [identifier] },
    { relays: ctx.config.relays },
  ).ready;
  // Authority boundary (audit APPK-1) + record-authority pinning (NIP §3.7): only a
  // record authored by the CURRENTLY assigned coordinator (or E_id) is trusted, so
  // a hostile relay or cached event from a formerly assigned coordinator is dropped.
  const latest = pickLatest(onlyByAuthors(onlyVerified(events), acceptedRecordAuthors(ctx)));
  if (!latest) return { v: 2, eck_current: 1, attendees: [] };
  // The roster is authored by the coordinator (or E_id) — a trusted authority
  // (onlyVerified + directoryPublisher). Distinguish a newer-protocol roster
  // (prompt an update, NIP §2 / D2) from a garbled one (drop).
  let raw: unknown;
  try {
    raw = JSON.parse(eckDecrypt(eck, latest.content));
  } catch {
    return undefined;
  }
  const parsed = parsePayloadSafe(rosterContentSchema, raw);
  if (!parsed.ok) {
    if (parsed.reason === "newer-version") updatePrompt.flag();
    return undefined;
  }
  cacheSet(rosterKey(ctx.coordinate), parsed.value, latest.created_at ?? 0);
  return parsed.value;
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

/**
 * Max values per `#d` filter (UX-22): relays with filter-size limits silently
 * truncate or reject a single REQ carrying hundreds of roster d-tags — the
 * roster then showed fewer people with no error. Chunk big rosters and merge
 * the chunk results instead.
 */
const D_FILTER_CHUNK_SIZE = 50;

function chunkDs(ds: string[]): string[][] {
  if (ds.length <= D_FILTER_CHUNK_SIZE) return [ds];
  const out: string[][] = [];
  for (let i = 0; i < ds.length; i += D_FILTER_CHUNK_SIZE) {
    out.push(ds.slice(i, i + D_FILTER_CHUNK_SIZE));
  }
  return out;
}

/**
 * Stream directory-entry events for a (possibly large) blinded-d list: one
 * streamEvents per `#d` chunk (UX-22), combined into a single handle. The
 * merged `ready` snapshot dedupes by event id; latest-wins per blinded d is
 * applied by the callers, exactly as with a single stream.
 */
function streamDirectoryEvents(
  authors: string[],
  ds: string[],
  relays: string[] | undefined,
  onEvent?: StreamOptions["onEvent"],
): StreamHandle {
  const parts = chunkDs(ds).map((chunk) =>
    streamEvents(
      { kinds: [KIND_DIRECTORY_ENTRY], authors, "#d": chunk },
      { relays, ...(onEvent ? { onEvent } : {}) },
    ),
  );
  return {
    ready: Promise.all(parts.map((p) => p.ready)).then((sets) => {
      const byId = new Map<string, (typeof sets)[number][number]>();
      for (const events of sets) for (const e of events) byId.set(e.id, e);
      return [...byId.values()];
    }),
    stop: () => parts.forEach((p) => p.stop()),
  };
}

/** Fetch + decrypt every directory entry listed in the roster. */
export async function fetchDirectory(
  ctx: EventContext,
): Promise<DirectoryEntryContent[]> {
  const eck = await eckBytesFor(ctx.coordinate);
  if (!eck) return [];
  const roster = await fetchRoster(ctx);
  if (!roster || roster.attendees.length === 0) return [];

  const authors = acceptedRecordAuthors(ctx);
  const ds = roster.attendees.map((a) => a.d);
  // Chunked #d filters (UX-22): a 200-attendee roster would otherwise exceed
  // relay filter-size limits and silently return fewer people.
  const events = onlyByAuthors(await streamDirectoryEvents(authors, ds, ctx.config.relays).ready, authors);
  // Keep the latest event per blinded d.
  const latestByD = new Map<string, (typeof events)[number]>();
  for (const e of events) {
    const d = e.tags.find((t) => t[0] === "d")?.[1];
    if (!d) continue;
    const prev = latestByD.get(d);
    if (!prev || supersedes(e, prev)) latestByD.set(d, e);
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
  const authors = acceptedRecordAuthors(ctx);
  const acceptedAuthors = new Set(acceptedRecordAuthors(ctx));
  const coord = ctx.coordinate;

  // Accumulate by PUBKEY (one entry per attendee), latest-wins by created_at, so
  // we can seed from the cached snapshot and a background refresh never flashes
  // the list down to fewer people (CACHING-PLAN §2.3, §3.4).
  // Track the winning event's (created_at, id) per pubkey so replacement follows
  // the SAME §3.1 rule as fetchDirectory (higher created_at, then lowest id) —
  // v1's `>=` here silently disagreed with fetchDirectory's `>` on ties. The
  // cached seed has no source event, so id "" / at 0 loses to any real event.
  const byPk = new Map<string, { entry: DirectoryEntryContent; at: number; id: string }>();
  const cached = cachedDirectory(coord);
  if (cached) for (const e of cached) byPk.set(e.pubkey, { entry: e, at: 0, id: "" });
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

  const onDirEvent = (e: { id: string; pubkey?: string; tags: string[][]; content: string; created_at?: number }) => {
    if (!e.tags.some((tg) => tg[0] === "d")) return;
    // Record-authority pinning (NIP §3.7): ignore a directory entry not authored by
    // the currently assigned coordinator (or E_id) — a stale-coordinator event.
    if (e.pubkey !== undefined && !acceptedAuthors.has(e.pubkey)) return;
    const at = e.created_at ?? 0;
    try {
      const entry = directoryEntryContentSchema.parse(JSON.parse(eckDecrypt(eck, e.content)));
      const prev = byPk.get(entry.pubkey);
      if (!prev || supersedes({ id: e.id, created_at: at }, { id: prev.id, created_at: prev.at })) {
        byPk.set(entry.pubkey, { entry, at, id: e.id });
      }
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
    // Chunked #d filters (UX-22); the composite handle stops/settles them all.
    inner = streamDirectoryEvents(authors, ds, ctx.config.relays, onDirEvent);
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
  // Record-authority pinning (NIP §3.7): a 31605 is authored by the CURRENTLY
  // assigned coordinator only. Guard the author so a hostile relay's injected event
  // (higher created_at, wrong author) can't win the latest-pick and shadow the real
  // list — it would fail to decrypt and drop the attendee's matches.
  const latest = pickLatest(onlyByAuthors(events, [coordinator]));
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
