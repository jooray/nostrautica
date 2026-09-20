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
  KIND_DM_RELAY_LIST,
  KIND_EVENT_CONFIG,
  isEventCoordinate,
  KIND_DIRECTORY_ENTRY,
  KIND_ROSTER,
  KIND_MATCH_LIST,
  GIFTWRAP_MAX_BACKDATE_SEC,
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
  mergeRosterPages,
  rosterContinuationDs,
  rosterPageD,
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
import {
  addEckVersions,
  applyOrganizerGrant,
  loadEventKeys,
  listEventKeys,
  currentEck,
  type EventKeys,
} from "./keystore.js";
import { acceptedRecordAuthors } from "./organizer.js";
import { fetchEvents, fetchEventsRelayOnly } from "$lib/nostr/ndk.js";
import { onlyVerified, onlyByAuthors } from "$lib/nostr/verify.js";
import { streamEvents, type StreamHandle, type StreamOptions } from "$lib/nostr/stream.js";
import { DEFAULT_RELAYS, unionRelays } from "$lib/nostr/relays.js";
import { eventRelayHints } from "./event-context.js";
import { cacheGet, cacheSet, whenCacheReady } from "$lib/cache/persist.js";
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
  // Both space kinds, via the protocol's own allowlist (audit R18). Comparing
  // against KIND_CALENDAR_EVENT alone silently refused every grant for a
  // community the moment 31612 existed: a key grant is how an approved member
  // receives the ECK, so a community would have worked for exactly one person,
  // its creator, who self-approves locally and would never have seen it fail.
  if (!isEventCoordinate(grant.a)) return false;
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
  // Both space kinds, via the protocol's own allowlist (audit R18). Comparing
  // against KIND_CALENDAR_EVENT alone silently refused every grant for a
  // community the moment 31612 existed: a key grant is how an approved member
  // receives the ECK, so a community would have worked for exactly one person,
  // its creator, who self-approves locally and would never have seen it fail.
  if (!isEventCoordinate(grant.a)) return false;
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

/** Per-identity marker: WHEN the last full-history grant backfill completed. */
function grantsBackfilledKey(pubkey: string): string {
  return `nostrautica-grants-backfilled:${pubkey}`;
}

/**
 * How long a completed full-history sweep is trusted before this device redoes
 * one.
 *
 * This marker used to be the string `"1"` and it was written ONCE, forever. That
 * is the bug behind the 2026-09-13 report, and it is worth stating concretely
 * because the failure is completely silent: the owner joined an event on their
 * desktop, opened the app on a phone that had been logged in for months, and the
 * event simply was not there — not stale, not spinning, absent, with the phone
 * cheerfully rendering "No events yet" underneath it. The phone had latched the
 * marker back in July, so every scan since then asked the relays only for wraps
 * newer than {@link grantScanSince}. The 21602 key grant was still
 * sitting on the relays the whole time; the phone had simply stopped asking a
 * question wide enough to include it, and nothing — not a relaunch, not the
 * Retry button, not a reinstall short of clearing site data — ever widened it
 * again.
 *
 * An attendee's ECK exists on the network in exactly ONE place (the one-shot
 * 21602 gift wrap; unlike an organizer, there is no 30078 self-backup to fall
 * back on), so a device that stops asking for old wraps has permanently lost the
 * only copy it could ever have fetched. A week is short enough that a missed
 * grant costs days rather than months, and long enough that the cost — one
 * paginated relay read, no signer round trips for anything already memoized — is
 * paid rarely.
 */
export const GRANT_BACKFILL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How far back the NARROW grant scan reads — the one that runs while the
 * backfill marker is still trusted.
 *
 * It is DERIVED from {@link GRANT_BACKFILL_TTL_MS}, not chosen, because the two
 * numbers are one mechanism and picking them independently opens a hole. They
 * were independent until 2026-09-17 and the hole was real: the marker let a
 * device skip the full sweep for 7 days while the narrow scan reached back only
 * `giftwrapSince()` = 3 days, so there were 4 days in the middle in which a grant
 * could be published and this device would never ask a question wide enough to
 * see it. NIP-59's up-to-2-day backdating (GIFTWRAP_MAX_BACKDATE_SEC) widens that
 * blind window to 6 days, since a wrap published on day 5 may legitimately carry
 * a `created_at` from day 3.
 *
 * Confirmed against a real report: an attendee approved on 2026-09-13 had both
 * their 21602 wraps sitting on the relays with `created_at` 09-12 and 09-13, and
 * on 09-17 their second device — which held keys for another event and so took
 * the narrow branch — was asking only for wraps newer than 09-14. The grant was
 * two days below the floor and the device was stuck on "waiting for organizer
 * approval" with no error anywhere.
 *
 * So the window must cover the whole interval this device is allowed to SKIP,
 * plus the jitter, plus a day of slack for clock skew between the publisher and
 * this device. Widening it costs one `since` value on a paginated relay read —
 * no extra signer round trips, because every wrap already processed is memoized.
 */
export const GRANT_SCAN_LOOKBACK_SEC =
  GRANT_BACKFILL_TTL_MS / 1000 + GIFTWRAP_MAX_BACKDATE_SEC + 24 * 60 * 60;

/** `since` for a narrow (marker-trusted) grant scan. See {@link GRANT_SCAN_LOOKBACK_SEC}. */
export function grantScanSince(nowSec: number = Math.floor(Date.now() / 1000)): number {
  return nowSec - GRANT_SCAN_LOOKBACK_SEC;
}

/**
 * Any stored value below this is not a timestamp this code wrote. In practice it
 * is the legacy `"1"`, which is the state EVERY affected device is in right now:
 * treat it as expired (not as "backfilled at 1ms past the epoch", and emphatically
 * not as fresh) so the first scan after this ships re-runs the full sweep and
 * recovers the grants those devices have been unable to see.
 */
const MIN_PLAUSIBLE_BACKFILL_MS = 1_000_000_000_000; // 2001-09-09

/** When the last trusted full sweep finished, or undefined if there isn't one. */
function backfilledAt(pubkey: string): number | undefined {
  try {
    const raw = localStorage.getItem(grantsBackfilledKey(pubkey));
    if (!raw) return undefined;
    const at = Number(raw);
    if (!Number.isFinite(at) || at < MIN_PLAUSIBLE_BACKFILL_MS) return undefined;
    return at;
  } catch {
    // Storage unavailable (private mode, disabled cookies): we cannot prove a
    // sweep ever ran, so the honest answer is "none" — a wider read, never a
    // narrower one.
    return undefined;
  }
}

function markGrantsBackfilled(pubkey: string, at: number = Date.now()): void {
  try {
    localStorage.setItem(grantsBackfilledKey(pubkey), String(at));
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

// v1 stored only `true`, including for accepted grants. It could not distinguish
// "not a grant" from "this grant was accepted once and its key is gone now", so
// it permanently skipped recovery after a partial storage wipe — and a build
// older than 2026-09-14 (2155a24), which rejected every 31612 community grant as
// forged, wrote exactly that entry, burning the wrap for good on any device that
// scanned before the fix shipped.
//
// The legacy `grantwraps` ledger is deliberately NOT migrated into this one: a
// bare `true` cannot say which of those two things it meant, so inheriting it
// would carry the burn forward. The cost of starting clean is one re-unwrap pass
// per device — bounded by the scan budget's call cap, and memoized under this key
// as it goes — and the old entry ages out with the rest of the cache.
export const GRANT_MEMO_KEY = "grantwraps-v2";
type GrantMemoEntry = true | { coordinate: string; versions: number[]; organizer: boolean };

function grantMemoSatisfied(entry: GrantMemoEntry | undefined, held: EventKeys[]): boolean {
  if (entry === true) return true; // definitively not an accepted grant
  if (!entry) return false;
  const keys = held.find((k) => k.coordinate === entry.coordinate);
  return !!keys && entry.versions.every((id) => keys.eck.some((v) => v.id === id)) &&
    (!entry.organizer || (keys.role === "organizer" && !!keys.eidNsecHex && !!keys.einboxNsecHex));
}

/**
 * Page size for the wrap read, and the cap on how many pages one sweep walks.
 *
 * The read used to carry NO `limit` at all, which does not mean "everything": it
 * means the RELAY picks, and relays answer an unbounded filter with their own
 * default cap, newest-first. So a full-history sweep on an account with a busy
 * NIP-17 inbox silently returned only the newest N wraps — and then latched the
 * backfill marker as if it had seen the whole history, which is the same
 * permanent blindness the marker's TTL above exists to prevent, arrived at from
 * the other side. Asking for an explicit page and walking backwards with `until`
 * is the only way to know whether we reached the end or the relay's ceiling.
 */
export const GRANT_PAGE_SIZE = 500;
export const GRANT_MAX_PAGES = 20;

/**
 * Accept only relay URLs we would dial. Deliberately a local check rather than
 * ndk's `isAcceptedRelayUrl`: the values here come from an untrusted kind-10050
 * published by anyone, and this module is on the login path where the ndk
 * surface is routinely stubbed — a seven-line guard is cheaper than the coupling.
 */
function isDialableRelay(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "wss:") return true;
    if (u.protocol !== "ws:") return false;
    return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Bound an untrusted 10050 so a hostile list can't crowd out the defaults. */
const MAX_INBOX_RELAYS = 20;

/**
 * The account's own NIP-17 inbox relays, resolved at most once per session.
 *
 * `receiveGrants` runs on nearly every event-page mount, so resolving this on
 * each call would put an extra subscription (and its EOSE wait) in front of work
 * that is already on the critical path for "which events are mine". A user's own
 * 10050 changes about as often as their relay preferences do; a session is a
 * perfectly good staleness bound, and the value only ever WIDENS the read set —
 * a stale one costs nothing but a relay we needn't have dialled.
 */
const inboxRelayCache = new Map<string, Promise<string[]>>();

/** Drop the per-session inbox-relay memo (logout, or tests). */
export function clearInboxRelayCache(): void {
  inboxRelayCache.clear();
}

function ownInboxRelays(pubkey: string): Promise<string[]> {
  let pending = inboxRelayCache.get(pubkey);
  if (!pending) {
    pending = (async () => {
      const lists = await fetchEvents({ kinds: [KIND_DM_RELAY_LIST], authors: [pubkey] });
      const latest = pickLatest(onlyVerified(lists));
      return (latest?.tags ?? [])
        .filter((t) => t[0] === "relay" && !!t[1] && isDialableRelay(t[1]))
        .map((t) => t[1]!)
        .slice(0, MAX_INBOX_RELAYS);
    })();
    inboxRelayCache.set(pubkey, pending);
    // A failed lookup must not be cached as "this account has no inboxes".
    pending.catch(() => inboxRelayCache.delete(pubkey));
  }
  return pending;
}

/**
 * Where to LOOK for wraps addressed to this account.
 *
 * `DEFAULT_RELAYS` alone was the read side of an asymmetry with the write side:
 * `publishAccountGiftWrap` (nostr/giftwrap-routing.ts) deliberately sends a grant
 * to the recipient's declared kind-10050 inboxes as well as the event + app
 * relays, precisely so it reaches the account's other clients — and then this
 * scan never looked at those inboxes. A grant delivered to an inbox the user
 * publishes but we don't read is a grant that exists and is invisible.
 *
 * Event relay hints are unioned in for the same reason (audit APPK-5 already
 * applies them to the 31600 lookup): an event living on custom relays may have
 * had its grant land there too.
 *
 * Best-effort and never narrowing: any failure leaves the defaults standing.
 */
async function grantScanRelays(pubkey: string, held: EventKeys[]): Promise<string[]> {
  let inboxes: string[] = [];
  try {
    inboxes = await ownInboxRelays(pubkey);
  } catch {
    /* no 10050, or the read failed — the defaults below still stand */
  }
  const hints: string[] = [];
  for (const k of held) {
    try {
      hints.push(...eventRelayHints(k.coordinate).filter(isDialableRelay));
    } catch {
      /* one unreadable hint must not cost us the whole relay set */
    }
  }
  return unionRelays(DEFAULT_RELAYS, inboxes, hints);
}

/**
 * One paginated read of the gift wraps addressed to `pubkey`.
 *
 * `complete` is false when we stopped for any reason other than reaching the end
 * of the history — the page cap, or a page that made no progress. Only a
 * `complete` full-history sweep may latch the backfill marker; anything else has
 * demonstrably not seen everything, and latching on it is how a device teaches
 * itself to stop looking.
 */
async function readGrantWraps(
  pubkey: string,
  relays: string[],
  since: number,
): Promise<{ wraps: GiftWrap[]; complete: boolean }> {
  const seen = new Set<string>();
  const wraps: GiftWrap[] = [];
  let until: number | undefined;
  for (let page = 0; page < GRANT_MAX_PAGES; page++) {
    const filter: Record<string, unknown> = {
      kinds: [KIND_GIFT_WRAP],
      "#p": [pubkey],
      since,
      limit: GRANT_PAGE_SIZE,
    };
    if (until !== undefined) filter.until = until;
    // Relay-only read (no dexie cache in the loop): grants must not be missed —
    // fetchEvents can EOSE-resolve before the cache adapter surfaces a wrap that
    // already arrived from the relay (found via e2e, TEST-REPORT-2026-07-13).
    // Explicit relay set: without one, NDK's outbox calculation can stall the
    // fetch indefinitely when relay lists are unresolvable (BUG-1b).
    const batch = (await fetchEventsRelayOnly(filter, relays)) as unknown as GiftWrap[];
    let added = 0;
    let oldest: number | undefined;
    for (const w of batch) {
      if (!seen.has(w.id)) {
        seen.add(w.id);
        wraps.push(w);
        added++;
      }
      if (oldest === undefined || w.created_at < oldest) oldest = w.created_at;
    }
    // A short page is the end of the history — the only way to actually finish.
    if (batch.length < GRANT_PAGE_SIZE) return { wraps, complete: true };
    // A full page that taught us nothing new (every id already seen, or no
    // timestamp to step back from) would loop forever on the same `until`.
    if (added === 0 || oldest === undefined) return { wraps, complete: false };
    // `until` is inclusive, so the boundary second is re-requested and the id
    // dedupe above absorbs it — stepping past it would drop wraps that share it.
    until = oldest;
  }
  return { wraps, complete: false };
}

export async function receiveGrants(
  signer: AppSigner,
  opts: {
    budget?: ScanBudget;
    onOutcome?: (outcome: ScanOutcome) => void;
    /**
     * Ignore the backfill marker and sweep the full history regardless. This is
     * the user pressing "Search my whole history": they are telling us the last
     * answer was wrong, and a marker written weeks ago must not turn that into a
     * no-op the way it did for the reporter's phone.
     */
    force?: boolean;
  } = {},
): Promise<string[]> {
  const pubkey = await signer.getPublicKey();
  // Bounded (see `scan-budget.ts`): every un-memoized wrap costs TWO signer
  // round trips (giftwrap.ts unwraps the wrap, then the seal), each with a 60s
  // ceiling on a remote signer and possibly a human approval dialog. Walking a
  // full-history backfill of them unbounded is the prompt storm behind the
  // 2026-07-28 "my events vanished" report. A truncated pass is reported rather
  // than swallowed, so the caller can distinguish it from an empty inbox.
  const budget = (opts.budget ?? startScanBudget()).fork();
  const outcome = emptyOutcome();
  // What this device already holds for this identity. Two jobs: it widens the
  // relay set (an event's own relays may have taken the grant), and an EMPTY
  // keystore is itself a reason to sweep the whole history regardless of the
  // marker — "I have no events at all" and "I already checked" cannot both be
  // true, and believing the marker in that state is what leaves a restored
  // identity staring at "No events yet" with a full inbox on the relays.
  const held = await listEventKeys(pubkey).catch(() => [] as EventKeys[]);
  const lastBackfill = backfilledAt(pubkey);
  const backfillExpired =
    lastBackfill === undefined || Date.now() - lastBackfill >= GRANT_BACKFILL_TTL_MS;
  const fullBackfill = opts.force === true || backfillExpired || held.length === 0;
  const relays = await grantScanRelays(pubkey, held);
  const { wraps, complete: readComplete } = await readGrantWraps(
    pubkey,
    relays,
    fullBackfill ? 0 : grantScanSince(),
  );
  // A read we could not finish must not be presented as the whole truth — it is
  // the same class of half-answer as a truncated signer budget, and the caller
  // (Home) needs it to say "this list may be incomplete" rather than "you have
  // no events".
  if (!readComplete) outcome.truncated = true;

  const coordinates = new Set<string>();
  // Did this scan prove the SIGNER can actually read our wraps? A full-history
  // backfill that unwrapped nothing is not evidence there was nothing to find —
  // on a remote signer (Amber) every unwrap is two NIP-46 round trips, and a
  // signer that was unreachable/unapproved for the whole pass fails all of them
  // identically to "no grants here". Latching `markGrantsBackfilled` on that
  // narrows every later scan to `grantScanSince()`, so an ECK
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
  // Behind the real mirror read: this memo is written back IN FULL below, so
  // loading it from a mirror that has not been hydrated yet does not merely lose
  // the memo for this scan — it persists the empty one over it, and every later
  // boot re-unwraps every gift wrap the user has ever received. That is the
  // Amber prompt storm this memo exists to prevent.
  await whenCacheReady();
  const memo = { ...(cacheGet<Record<string, GrantMemoEntry>>(GRANT_MEMO_KEY, pubkey)?.data ?? {}) };
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
    if (grantMemoSatisfied(memo[wrap.id], held)) continue;
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
      let raw: unknown;
      try {
        raw = JSON.parse(rumor.content);
      } catch {
        memo[wrap.id] = true; // not even JSON — definitive, never re-try
        memoDirty = true;
        continue;
      }
      // A grant sealed by the E_id/coordinator authority (rumor.pubkey is bound
      // by signerUnwrap) that carries a newer protocol version means this client
      // is stale (NIP §2 / D2) — prompt an update.
      const newerProtocol = isNewerProtocolVersion(raw);
      if (newerProtocol) updatePrompt.flag();
      try {
        grant = organizerGrantContentSchema.parse(raw);
      } catch {
        // NOT definitive when the payload is simply newer than this build (D2):
        // memoizing it meant the app auto-updated minutes later and then never
        // looked at that wrap again, so a grant we were one release away from
        // understanding stayed permanently unread. Leave it for the updated
        // build. A parse failure at the CURRENT version is genuinely malformed.
        if (!newerProtocol) {
          memo[wrap.id] = true;
          memoDirty = true;
        }
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
      memo[wrap.id] = { coordinate: grant.a, versions: grant.eck.map((v) => v.id), organizer: true };
      memoDirty = true;
      continue;
    }
    if (rumor.kind === KIND_KEY_GRANT) {
      let grant;
      let raw: unknown;
      try {
        raw = JSON.parse(rumor.content);
      } catch {
        memo[wrap.id] = true; // not even JSON — definitive
        memoDirty = true;
        continue;
      }
      // Newer-protocol grant from the authenticated E_id/coordinator authority:
      // prompt an update (NIP §2 / D2) before dropping it.
      const newerProtocol = isNewerProtocolVersion(raw);
      if (newerProtocol) updatePrompt.flag();
      try {
        grant = keyGrantContentSchema.parse(raw);
      } catch {
        // See the 21605 branch: a payload from a NEWER protocol version is not a
        // malformed one, and memoizing it burned the grant permanently — the PWA
        // auto-updates within a minute, and the build that could finally read it
        // had already been told never to look again.
        if (!newerProtocol) {
          memo[wrap.id] = true;
          memoDirty = true;
        }
        continue;
      }
      const config = await configFor(grant.a, eventRelayHints(grant.a));
      if (!config) {
        // The event's signed 31600 isn't fetchable right now (transient relay
        // gap, or an event living on relays we haven't recorded yet), and
        // authenticateKeyGrant can't establish the granting authority without
        // it. This is NOT a definitive negative — leave the wrap un-memoized so
        // the next scan retries (audit APPK-5).
        //
        // But it was also completely SILENT, which is worse than the retry is
        // good: a device that can reach the wrap but not the event's relays sits
        // in this branch on every scan forever, holding an unopened key grant,
        // while Home renders "No events yet" with total confidence. Count it and
        // say it, so the UI can offer the one true sentence — "a key grant is
        // waiting, but this device can't reach that event's relays".
        outcome.unreachableEvents++;
        console.warn(
          "[receiveGrants] a 21602 key grant is waiting for",
          grant.a,
          "but its signed 31600 config could not be fetched from any known relay" +
            " — cannot authenticate the grant, will retry on the next scan",
        );
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
      memo[wrap.id] = { coordinate: grant.a, versions: grant.eck.map((v) => v.id), organizer: false };
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
  // AND was meaningful: the read returned wraps, and either the signer unwrapped
  // at least one or none of them were addressed to us. A pass where every single
  // unwrap failed is a signer/transport outage, not an empty inbox — leave the
  // marker unset so the next scan re-runs the full history.
  //
  // `wraps.length > 0` is part of that (audit A-3). `fetchEventsRelayOnly` does
  // NOT reject on failure: it settles with whatever arrived inside its window, so
  // a relay timeout, a dropped socket, or an EOSE that beat the wraps home all
  // look identical to a genuinely empty inbox — and `unwrapFailed === 0` was
  // trivially true for all of them. Latching on that narrowed every later scan on
  // this device to `grantScanSince()`, which made an ECK grant for an
  // event joined last month PERMANENTLY undiscoverable here: the user opens their
  // own event and is told they're a visitor who should join. An identity whose
  // inbox really is empty simply keeps doing the full-history read — which is a
  // filter with `since: 0` that returns nothing, and stops as soon as their first
  // wrap arrives and unwraps.
  //
  // `readComplete` joins that list (and `outcome.truncated` now carries it too,
  // so the check below is belt-and-braces): a sweep the RELAY cut short at its
  // page ceiling saw only the newest slice of the history and knows nothing about
  // what lies behind it. Latching on that is indistinguishable, a week later,
  // from having genuinely read everything.
  if (
    fullBackfill &&
    readComplete &&
    wraps.length > 0 &&
    !outcome.truncated &&
    (unwrapped > 0 || unwrapFailed === 0)
  ) {
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
    cacheSet(GRANT_MEMO_KEY, memo, Math.floor(Date.now() / 1000), pubkey);
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

/**
 * Concurrent reads of the SAME roster/directory for the SAME coordinate share
 * one relay round-trip and one decrypt+verify pass.
 *
 * Not a cache and deliberately not time-based: an entry lives only while the
 * read is in flight, so every fresh call still hits relays and the roster can
 * never go stale behind a TTL. What it removes is pure duplicate work that the
 * app was doing on every single "open an event" (measured on a 120-person
 * roster, simulated 300 ms relay RTT):
 *
 *  - `prefetchAttendeesTab` and `prefetchEventContent` both call
 *    `fetchDirectory`, back to back, for the same coordinate — two full entry
 *    reads, 240 Schnorr verifies and 240 ECK decrypts instead of 120 of each.
 *    Signature verification is ~1.2 ms per event on a laptop (measured; ECK
 *    decryption is ~0.03 ms, 40x cheaper), so the duplicate pass alone was
 *    ~140 ms of blocking main-thread crypto on a laptop and several times that
 *    on a phone — spent while the event page was still painting.
 *  - `fetchDirectory` fetches the roster itself, so the warm-up's own
 *    `fetchRoster` call was a third round-trip for the same event.
 *  - Worst of all, tapping People while the warm-up was still running started
 *    ANOTHER roster read from scratch, even though an identical one had been in
 *    flight for half a second. That read gates the whole screen: until it
 *    lands, `streamDirectory` doesn't know which blinded d's to ask for.
 */
const inflightRoster = new Map<string, Promise<RosterContent | undefined>>();
const inflightDirectory = new Map<string, Promise<DirectoryEntryContent[]>>();

function share<T>(map: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  const running = map.get(key);
  if (running) return running;
  const job = run().finally(() => {
    if (map.get(key) === job) map.delete(key);
  });
  map.set(key, job);
  return job;
}

/** Test-only: drop shared in-flight reads between cases. */
export function __resetAttendeeInflightForTests(): void {
  inflightRoster.clear();
  inflightDirectory.clear();
}

/** Fetch + decrypt the roster. Returns undefined if the user isn't approved. */
export function fetchRoster(ctx: EventContext): Promise<RosterContent | undefined> {
  return share(inflightRoster, ctx.coordinate, () => fetchRosterOnce(ctx));
}

async function fetchRosterOnce(ctx: EventContext): Promise<RosterContent | undefined> {
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
  // A roster too big for one NIP-44 payload is split across pages
  // (PROTOCOL-NIP.md §6.2): page 0 says how many there are, and the rest come
  // back in one more REQ. A page we cannot read means we do not know the
  // membership, so this answers "no roster" rather than handing the People
  // screen a list that is missing everyone past page 0.
  const pages = parsed.value.pages ?? 1;
  let roster = parsed.value;
  if (pages > 1) {
    const rest = await fetchRosterContinuation(ctx, eck, latest.pubkey!, pages);
    if (!rest) {
      console.warn(`[roster] ${ctx.coordinate}: page 0 says ${pages} pages, not all of them read`);
      return undefined;
    }
    roster = mergeRosterPages([parsed.value, ...rest]);
  }
  cacheSet(rosterKey(ctx.coordinate), roster, latest.created_at ?? 0);
  return roster;
}

/**
 * Pages 1..N-1 of a paginated roster, in ONE REQ, from the same author whose
 * page 0 we just accepted. `undefined` if any page is missing, authored by
 * someone else, addressed to another coordinate, or will not decrypt.
 *
 * The `a`-tag check matters because page N is addressed `<event-d>:N`, which a
 * DIFFERENT space under the same coordinator could hold as its own `d`. The
 * content is ECK-encrypted per event, so the worst such a collision could do is
 * withhold a page — but withholding it silently is exactly what must not happen.
 */
async function fetchRosterContinuation(
  ctx: EventContext,
  eck: Uint8Array,
  author: string,
  pages: number,
): Promise<RosterContent[] | undefined> {
  const { identifier } = parseCoordinate(ctx.coordinate);
  const ds = rosterContinuationDs(identifier, pages);
  const events = await streamEvents(
    { kinds: [KIND_ROSTER], authors: [author], "#d": ds },
    { relays: ctx.config.relays },
  ).ready;
  const usable = onlyByAuthors(onlyVerified(events), [author]).filter((e) =>
    e.tags?.some((t) => t[0] === "a" && t[1] === ctx.coordinate),
  );
  const out: RosterContent[] = [];
  for (let page = 1; page < pages; page++) {
    const d = rosterPageD(identifier, page);
    const latest = pickLatest(usable.filter((e) => e.tags?.some((t) => t[0] === "d" && t[1] === d)));
    if (!latest) return undefined;
    try {
      const parsed = parsePayloadSafe(rosterContentSchema, JSON.parse(eckDecrypt(eck, latest.content)));
      if (!parsed.ok) {
        if (parsed.reason === "newer-version") updatePrompt.flag();
        return undefined;
      }
      out.push(parsed.value);
    } catch {
      return undefined;
    }
  }
  return out;
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
    // ALL parts, not any: this is a fan-out over `d` chunks, so an absence is
    // only believable when every chunk was answered (see StreamHandle.answered).
    answered: () => parts.every((p) => p.answered()),
    ready: Promise.all(parts.map((p) => p.ready)).then((sets) => {
      const byId = new Map<string, (typeof sets)[number][number]>();
      for (const events of sets) for (const e of events) byId.set(e.id, e);
      return [...byId.values()];
    }),
    stop: () => parts.forEach((p) => p.stop()),
  };
}

/** Fetch + decrypt every directory entry listed in the roster. */
export function fetchDirectory(ctx: EventContext): Promise<DirectoryEntryContent[]> {
  return share(inflightDirectory, ctx.coordinate, () => fetchDirectoryOnce(ctx));
}

async function fetchDirectoryOnce(
  ctx: EventContext,
): Promise<DirectoryEntryContent[]> {
  const eck = await eckBytesFor(ctx.coordinate);
  console.log("[DIAG fetchDirectoryOnce] eck present?", !!eck);
  if (!eck) return [];
  const roster = await fetchRoster(ctx);
  console.log("[DIAG fetchDirectoryOnce] roster", roster && { n: roster.attendees.length, ds: roster.attendees.map(a=>a.d) });
  if (!roster || roster.attendees.length === 0) return [];

  const authors = acceptedRecordAuthors(ctx);
  console.log("[DIAG fetchDirectoryOnce] authors", authors, "coordinator", ctx.config.coordinator, "eidPubkey", ctx.config.eidPubkey);
  const ds = roster.attendees.map((a) => a.d);
  // Chunked #d filters (UX-22): a 200-attendee roster would otherwise exceed
  // relay filter-size limits and silently return fewer people.
  const rawEvents = await streamDirectoryEvents(authors, ds, ctx.config.relays).ready;
  console.log("[DIAG fetchDirectoryOnce] rawEvents", rawEvents.map((e:any)=>({id: e.id?.slice(0,8), pubkey: e.pubkey?.slice(0,8), tags: e.tags, created_at: e.created_at})));
  const events = onlyByAuthors(rawEvents, authors);
  console.log("[DIAG fetchDirectoryOnce] afterOnlyByAuthors count", events.length);
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
    } catch (err) {
      /* skip entries we can't decrypt (e.g. published under a newer ECK) */
      console.log("[DIAG fetchDirectoryOnce] decrypt/parse FAILED for", e.id?.slice(0,8), err);
    }
  }
  console.log("[DIAG fetchDirectoryOnce] final entries", entries.map(e=>({pubkey: e.pubkey?.slice(0,8), hasAi: !!e.ai_profile})));
  cacheDirectory(ctx.coordinate, entries, newestAt);
  return entries;
}

export interface DirectoryStream {
  /** Settles at first-EOSE+grace or timeout with everything decrypted so far. */
  ready: Promise<DirectoryEntryContent[]>;
  stop: () => void;
  /**
   * Directory entries arrived that this device could NOT decrypt (audit EV-9).
   *
   * The distinction the roster view could not draw. Holding an ECK is what
   * `hasKey` reports, and it says nothing about whether that ECK is the CURRENT
   * one: a member who was revoked, or whose grant for a rotation hasn't landed
   * yet, holds a stale key, decrypts nothing, and was shown "Nobody is on the
   * list yet". That is a claim about the event, and the wrong one — the people
   * are there, this device just can't read them.
   */
  undecryptable: () => number;
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
  // By event id, so a relay re-delivering the same entry is not counted twice.
  const undecryptable = new Set<string>();

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
      // Skipped, but COUNTED: an entry published under an ECK we don't hold is
      // the signal that this device's access is stale, and swallowing it is what
      // turned a revoked member's view into "nobody is here" (EV-9).
      undecryptable.add(e.id);
    }
  };

  // Paint whatever we already have, instantly.
  if (byPk.size) onEntries(snapshot());

  // A People-tab warm-up may already be fetching and decrypting this exact
  // directory (prefetch.ts starts one the moment the event page knows this
  // device holds an ECK). Adopt its result the instant it lands instead of
  // painting nothing until THIS stream's own round-trip returns: tapping People
  // 800 ms into a warm-up used to wait out a fresh roster read plus a fresh
  // entry read, ~1.2 s, for entries that were already decrypted 400 ms later in
  // the other pass. Adopted entries are seeded like the cached ones (at 0) so a
  // real event from this stream always supersedes them; they replace a cache
  // seed (also at 0) because the warm's snapshot is strictly the fresher of the
  // two. Never awaited — a slow or dead warm must not hold up this stream.
  const pendingWarm = inflightDirectory.get(coord);
  if (pendingWarm) {
    void pendingWarm
      .then((warmed) => {
        if (!warmed.length) return;
        let adopted = false;
        for (const entry of warmed) {
          const prev = byPk.get(entry.pubkey);
          if (prev && prev.at !== 0) continue; // a real event already won
          byPk.set(entry.pubkey, { entry, at: 0, id: "" });
          adopted = true;
        }
        if (adopted) scheduleFlush();
      })
      .catch(() => {});
  }

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
    undecryptable: () => undecryptable.size,
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
