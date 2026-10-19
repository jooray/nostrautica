/** @module @category Client - Group Manager */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { logger } from "../utils/debug.js";
import { normalizeRelayUrl } from "../utils/relay-url.js";
const log = logger.extend("GroupBackfill");
/** Default overlap re-fetched behind the stored cursor (seconds). */
export const DEFAULT_BACKFILL_SLACK_SECONDS = 10 * 60;
/** Default `limit` of each backfill page. */
export const DEFAULT_BACKFILL_PAGE_SIZE = 500;
/** Default maximum number of pages fetched per relay on one connect. */
export const DEFAULT_BACKFILL_MAX_PAGES = 50;
/**
 * Events dated further than this into the future never advance the cursor
 * (seconds). A single skewed or hostile `created_at` must not push the cursor
 * past events that have not been published yet.
 */
export const BACKFILL_FUTURE_SKEW_SECONDS = 5 * 60;
/**
 * Furthest an event held in memory can hold a cursor back (seconds): an
 * event dated more than this before the newest fetched event no longer holds
 * the cursor. An undecryptable event dated far in the past must not force a
 * long re-fetch on every connect.
 */
export const BACKFILL_MAX_HOLD_BACK_SECONDS = 7 * 24 * 60 * 60;
/**
 * Result cap assumed for a relay that has not shown its own (capped at
 * `pageSize`). NIP-01 sets no minimum, but relays cap in the hundreds; below
 * this a one-second page is taken as the whole second, so a small or new
 * group's history does not read as truncated and stall the cursor.
 */
export const BACKFILL_ASSUMED_MIN_RELAY_CAP = 100;
const CURSOR_FORMAT_VERSION = 1;
/**
 * Key segment for a relay: its normalised URL (so `wss://r` and `wss://r/`
 * share records), hashed so arbitrary URLs make well-formed keys.
 */
function relayKey(relay) {
    let url = relay;
    try {
        url = normalizeRelayUrl(relay);
    }
    catch {
        // Not a parseable URL: key it as given.
    }
    return bytesToHex(sha256(utf8ToBytes(url)));
}
/**
 * Key of a relay's backfill cursor for a group in the ingest-state store
 * (one record per group relay). It lives under the `${groupIdHex}/` prefix so
 * group-scoped ingest-state cleanup (disband) removes it with the rest of the
 * group's ingest state.
 */
export function backfillCursorKey(groupIdHex, relay) {
    return `${groupIdHex}/ingest/backfill-cursor/v1/${relayKey(relay)}`;
}
/** Encodes a cursor (unix seconds) as a version byte + big-endian uint32. */
export function encodeBackfillCursor(createdAt) {
    const bytes = new Uint8Array(5);
    bytes[0] = CURSOR_FORMAT_VERSION;
    new DataView(bytes.buffer).setUint32(1, createdAt);
    return bytes;
}
/** Decodes a stored cursor; returns `undefined` for missing or malformed bytes. */
export function decodeBackfillCursor(bytes) {
    if (!bytes || bytes.length !== 5 || bytes[0] !== CURSOR_FORMAT_VERSION)
        return undefined;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
}
/**
 * Reads a relay's backfill cursor for a group. A malformed cursor, or one
 * dated implausibly far in the future, is ignored so the caller falls back to
 * a full (paged) backfill of that relay rather than skipping history.
 */
export async function readBackfillCursor(store, groupIdHex, relay, nowSeconds) {
    const cursor = decodeBackfillCursor(await store.getItem(backfillCursorKey(groupIdHex, relay)));
    if (cursor === undefined)
        return undefined;
    if (cursor > nowSeconds + BACKFILL_FUTURE_SKEW_SECONDS) {
        log("ignoring future-dated cursor %d for group %s", cursor, groupIdHex);
        return undefined;
    }
    return cursor;
}
/**
 * Key of a relay's resumable paging progress for a group (bounded: one record
 * per group relay). Lives under the group's ingest-state prefix, like the
 * cursor.
 */
export function backfillProgressKey(groupIdHex, relay) {
    return `${groupIdHex}/ingest/backfill-progress/v1/${relayKey(relay)}`;
}
/** Encodes progress as a version byte + two big-endian uint32s. */
export function encodeBackfillProgress(progress) {
    const bytes = new Uint8Array(9);
    bytes[0] = CURSOR_FORMAT_VERSION;
    const view = new DataView(bytes.buffer);
    view.setUint32(1, progress.from);
    view.setUint32(5, progress.to);
    return bytes;
}
/** Decodes stored progress; `undefined` for missing or malformed bytes. */
export function decodeBackfillProgress(bytes) {
    if (!bytes || bytes.length !== 9 || bytes[0] !== CURSOR_FORMAT_VERSION)
        return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const progress = { from: view.getUint32(1), to: view.getUint32(5) };
    return progress.from <= progress.to ? progress : undefined;
}
/**
 * Reads a relay's stored paging progress for a group. Malformed progress, or
 * progress dated implausibly far in the future, is ignored (the relay is then
 * paged from its newest event as usual).
 */
export async function readBackfillProgress(store, groupIdHex, relay, nowSeconds) {
    const progress = decodeBackfillProgress(await store.getItem(backfillProgressKey(groupIdHex, relay)));
    if (!progress || progress.to > nowSeconds + BACKFILL_FUTURE_SKEW_SECONDS)
        return undefined;
    return progress;
}
/**
 * Fetches `filter` from each relay in `limit`-sized pages, walking `until`
 * backwards from the newest event.
 *
 * Each relay is paged independently: relays cap result counts differently, so
 * the oldest event of a merged multi-relay page says nothing about how far
 * back any single relay has been read. Paging stops on a page that contributes
 * no new events rather than on a "short" page, because a relay whose own cap
 * is below `pageSize` returns short pages while it still has older events.
 * `until` is inclusive, so a page boundary that splits one second is re-read
 * (duplicates are dropped by id) before stepping past that second. A single
 * second holding a full page of events cannot be paged past with `until`
 * alone (a NIP-01 limitation): the walk steps past it but reports the relay
 * `saturated`, so the caller does not treat the backfill as complete. Without
 * evidence of the relay's cap (a longer response, or a truncated page), a
 * single-second page of at least {@link BACKFILL_ASSUMED_MIN_RELAY_CAP} events
 * is assumed to be truncated; a relay capping below that is not detected.
 *
 * A response containing an event outside the requested window (a relay that
 * ignores `since` or `until`) reports the relay `failed`. A response longer
 * than `pageSize` keeps only its newest `pageSize` events and the walk
 * continues from there, so each relay retains at most `pageSize * maxPages`
 * events. The network adapter still receives each response whole.
 */
export async function fetchPagedBackfill(network, relays, filter, options) {
    const accept = options.accept ?? (() => true);
    const pageRelay = async (relay) => {
        // Accepted copies, and rejected copies of ids with no accepted copy (yet).
        const collected = new Map();
        const rejected = new Map();
        const seen = new Set();
        const resume = options.resume?.get(relay);
        const since = options.since?.get(relay);
        let until;
        let steppedPastBoundary = false;
        // Largest single-second boundary page the walk stepped past. Judged
        // against the cap only when the walk ends: the cap may be confirmed
        // (lowered) after the boundary was passed, which makes it saturated.
        let largestSkippedBoundary = 0;
        // Per-request cap this relay has been proven to enforce: a page is only
        // "full" at `pageSize`, or at the length of an earlier page the relay
        // truncated (the next, narrower request still found new events).
        let confirmedCap = options.pageSize;
        // Longest response seen, at least the assumed minimum cap. A boundary
        // page shorter than this was not cut at the relay's cap; one as long may
        // have been (a relay capped below `pageSize` and a short history look the
        // same).
        let longestResponse = Math.min(options.pageSize, BACKFILL_ASSUMED_MIN_RELAY_CAP);
        let previousLength;
        const saturated = () => {
            if (largestSkippedBoundary === 0 ||
                largestSkippedBoundary < Math.min(confirmedCap, longestResponse))
                return false;
            log("relay %s saturated a second (cap %d)", relay, confirmedCap);
            return true;
        };
        const failed = () => ({
            collected,
            rejected,
            outcome: { relay, status: "failed" },
        });
        const done = () => ({
            collected,
            rejected,
            outcome: saturated()
                ? { relay, status: "saturated" }
                : { relay, status: "complete" },
        });
        for (let page = 0; page < options.maxPages; page++) {
            if (options.signal?.aborted)
                return failed();
            let events = await network.request([relay], {
                ...filter,
                limit: options.pageSize,
                ...(since !== undefined ? { since } : {}),
                ...(until !== undefined ? { until } : {}),
            });
            if (!events.length)
                return done();
            // A relay that answers outside the requested window (ignoring `until`
            // or `since`) gives no basis for deciding what it has left unsent.
            if (events.some((event) => (until !== undefined && event.created_at > until) ||
                (since !== undefined && event.created_at < since))) {
                log("relay %s answered outside the requested window", relay);
                return failed();
            }
            // A relay that ignores `limit`: keep the newest page, as a relay
            // honouring it would have returned. The remainder is re-read below.
            if (events.length > options.pageSize) {
                log("relay %s returned more than %d events", relay, options.pageSize);
                events = [...events]
                    .sort((a, b) => b.created_at - a.created_at)
                    .slice(0, options.pageSize);
            }
            longestResponse = Math.max(longestResponse, events.length);
            let added = 0;
            let oldest = Number.POSITIVE_INFINITY;
            let newest = Number.NEGATIVE_INFINITY;
            for (const event of events) {
                if (event.created_at < oldest)
                    oldest = event.created_at;
                if (event.created_at > newest)
                    newest = event.created_at;
                if (!seen.has(event.id)) {
                    seen.add(event.id);
                    added++;
                }
                if (collected.has(event.id))
                    continue;
                if (accept(event)) {
                    collected.set(event.id, event);
                    rejected.delete(event.id);
                }
                else if (!rejected.has(event.id))
                    rejected.set(event.id, event);
            }
            if (added > 0) {
                // This request is narrower than the previous one yet found new
                // events, so the previous page was truncated at the relay's cap.
                if (previousLength !== undefined)
                    confirmedCap = Math.min(confirmedCap, previousLength);
                until = oldest;
                steppedPastBoundary = false;
            }
            else if (steppedPastBoundary) {
                // Every event older than the stepped-past second is new to this
                // walk, so a non-empty page without one is a relay misbehaving.
                log("relay %s repeated events below a stepped-past second", relay);
                return failed();
            }
            else {
                // Everything at or after `until` is already collected. A full page
                // from one second means that second may hold more events than one
                // page can return; they cannot be reached. Whether the page is
                // "full" is decided at the end, against the final confirmed cap.
                if (oldest === newest)
                    largestSkippedBoundary = Math.max(largestSkippedBoundary, events.length);
                // Step past the boundary second once before concluding.
                until = oldest - 1;
                steppedPastBoundary = true;
            }
            // Reached a range an earlier capped backfill already fetched: resume
            // below it instead of re-reading it.
            previousLength = events.length;
            if (resume && until <= resume.to && until > resume.from) {
                until = resume.from;
                steppedPastBoundary = false;
                // The next request is not narrower than this one: no cap evidence.
                previousLength = undefined;
            }
            if (since !== undefined && until < since)
                return done();
        }
        log("relay %s hit the %d-page backfill cap", relay, options.maxPages);
        // A saturated walk is never recorded as resumable progress: resuming
        // would skip past the second it could not enumerate.
        if (saturated())
            return done();
        return {
            collected,
            rejected,
            outcome: { relay, status: "capped", until: Math.max(0, until) },
        };
    };
    const settled = await Promise.allSettled(relays.map(pageRelay));
    const failures = settled.filter((r) => r.status === "rejected");
    if (failures.length === settled.length && failures.length > 0)
        throw failures[0].reason;
    const merged = new Map();
    const rejected = new Map();
    const outcomes = [];
    const relayEvents = new Map();
    settled.forEach((result, i) => {
        if (result.status === "rejected") {
            log("backfill request failed: %o", result.reason);
            outcomes.push({ relay: relays[i], status: "failed" });
            return;
        }
        outcomes.push(result.value.outcome);
        relayEvents.set(relays[i], [...result.value.collected.values()]);
        for (const [id, event] of result.value.collected)
            if (!merged.has(id))
                merged.set(id, event);
        for (const [id, event] of result.value.rejected)
            if (!rejected.has(id))
                rejected.set(id, event);
    });
    for (const id of merged.keys())
        rejected.delete(id);
    return {
        events: [...merged.values(), ...rejected.values()],
        complete: outcomes.every((o) => o.status === "complete"),
        relays: outcomes,
        relayEvents,
    };
}
/**
 * Computes a relay's cursor to persist after its complete backfill has been
 * ingested.
 *
 * The cursor is the newest plausibly-dated ingested event; events dated more
 * than {@link BACKFILL_FUTURE_SKEW_SECONDS} ahead of `nowSeconds` are ignored.
 * Events the group is still holding only in memory — none of it durable
 * across a restart — cap the cursor at their `created_at`, so the next
 * connect re-fetches them. Two kinds:
 *
 * - `held`: its ingestion pool and capacity-refused input (see
 *   `MarmotGroup.pendingEvents()`), which may be undecryptable for good. They
 *   hold the cursor back by at most {@link BACKFILL_MAX_HOLD_BACK_SECONDS}
 *   below the newest event.
 * - `retained`: input set aside while a commit publication or merge is in
 *   progress, which is processed once it settles. That is bounded by the
 *   publication, not by luck, so the hold-back has no floor: a first connect
 *   with a long history must not skip the part of it still unprocessed.
 *
 * Returns `undefined` when there is nothing to store.
 */
export function nextBackfillCursor(options) {
    const horizon = options.nowSeconds + BACKFILL_FUTURE_SKEW_SECONDS;
    let newest;
    for (const event of options.ingested) {
        if (event.created_at > horizon)
            continue;
        if (newest === undefined || event.created_at > newest)
            newest = event.created_at;
    }
    if (newest === undefined)
        return options.previous;
    const oldestHeld = oldestCreatedAt(options.held);
    const oldestRetained = oldestCreatedAt(options.retained ?? []);
    if (oldestHeld === undefined && oldestRetained === undefined)
        return Math.max(options.previous ?? newest, newest);
    return Math.min(oldestHeld === undefined
        ? newest
        : Math.max(Math.min(newest, oldestHeld), newest - BACKFILL_MAX_HOLD_BACK_SECONDS), oldestRetained === undefined ? newest : Math.min(newest, oldestRetained));
}
/** The oldest `created_at` among `events` at or after `from`, if any. */
export function oldestCreatedAt(events, from = Number.NEGATIVE_INFINITY) {
    let oldest;
    for (const event of events)
        if (event.created_at >= from &&
            (oldest === undefined || event.created_at < oldest))
            oldest = event.created_at;
    return oldest;
}
