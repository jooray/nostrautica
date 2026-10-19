import type { NostrEvent } from "applesauce-core/helpers";
import type { Filter } from "applesauce-core/helpers/filter";
import type { GenericKeyValueStore } from "../utils/key-value.js";
import type { NostrNetworkInterface } from "./nostr-interface.js";
/** Default overlap re-fetched behind the stored cursor (seconds). */
export declare const DEFAULT_BACKFILL_SLACK_SECONDS: number;
/** Default `limit` of each backfill page. */
export declare const DEFAULT_BACKFILL_PAGE_SIZE = 500;
/** Default maximum number of pages fetched per relay on one connect. */
export declare const DEFAULT_BACKFILL_MAX_PAGES = 50;
/**
 * Events dated further than this into the future never advance the cursor
 * (seconds). A single skewed or hostile `created_at` must not push the cursor
 * past events that have not been published yet.
 */
export declare const BACKFILL_FUTURE_SKEW_SECONDS: number;
/**
 * Furthest an event held in memory can hold a cursor back (seconds): an
 * event dated more than this before the newest fetched event no longer holds
 * the cursor. An undecryptable event dated far in the past must not force a
 * long re-fetch on every connect.
 */
export declare const BACKFILL_MAX_HOLD_BACK_SECONDS: number;
/**
 * Result cap assumed for a relay that has not shown its own (capped at
 * `pageSize`). NIP-01 sets no minimum, but relays cap in the hundreds; below
 * this a one-second page is taken as the whole second, so a small or new
 * group's history does not read as truncated and stall the cursor.
 */
export declare const BACKFILL_ASSUMED_MIN_RELAY_CAP = 100;
/**
 * Key of a relay's backfill cursor for a group in the ingest-state store
 * (one record per group relay). It lives under the `${groupIdHex}/` prefix so
 * group-scoped ingest-state cleanup (disband) removes it with the rest of the
 * group's ingest state.
 */
export declare function backfillCursorKey(groupIdHex: string, relay: string): string;
/** Encodes a cursor (unix seconds) as a version byte + big-endian uint32. */
export declare function encodeBackfillCursor(createdAt: number): Uint8Array;
/** Decodes a stored cursor; returns `undefined` for missing or malformed bytes. */
export declare function decodeBackfillCursor(bytes: Uint8Array | null | undefined): number | undefined;
/**
 * Reads a relay's backfill cursor for a group. A malformed cursor, or one
 * dated implausibly far in the future, is ignored so the caller falls back to
 * a full (paged) backfill of that relay rather than skipping history.
 */
export declare function readBackfillCursor(store: GenericKeyValueStore<Uint8Array>, groupIdHex: string, relay: string, nowSeconds: number): Promise<number | undefined>;
/**
 * Key of a relay's resumable paging progress for a group (bounded: one record
 * per group relay). Lives under the group's ingest-state prefix, like the
 * cursor.
 */
export declare function backfillProgressKey(groupIdHex: string, relay: string): string;
/**
 * Resumable paging progress of one relay: every event the relay held dated in
 * `[from, to]` (inclusive, whole seconds) was fetched and durably ingested by an earlier,
 * page-capped backfill. Recorded only while that relay's backfill is
 * incomplete, and removed once a backfill of the relay completes.
 */
export interface BackfillProgress {
    from: number;
    to: number;
}
/** Encodes progress as a version byte + two big-endian uint32s. */
export declare function encodeBackfillProgress(progress: BackfillProgress): Uint8Array;
/** Decodes stored progress; `undefined` for missing or malformed bytes. */
export declare function decodeBackfillProgress(bytes: Uint8Array | null | undefined): BackfillProgress | undefined;
/**
 * Reads a relay's stored paging progress for a group. Malformed progress, or
 * progress dated implausibly far in the future, is ignored (the relay is then
 * paged from its newest event as usual).
 */
export declare function readBackfillProgress(store: GenericKeyValueStore<Uint8Array>, groupIdHex: string, relay: string, nowSeconds: number): Promise<BackfillProgress | undefined>;
/** Options for {@link fetchPagedBackfill}. */
export interface PagedBackfillOptions {
    /**
     * Per-relay lower bound passed as `since`; a relay without one is paged
     * through its full history.
     */
    since?: ReadonlyMap<string, number>;
    /** `limit` of each page. */
    pageSize: number;
    /** Maximum pages fetched from each relay. */
    maxPages: number;
    /**
     * Per-relay ranges already fetched by an earlier capped backfill. Once a
     * relay's walk has paged down to `to`, it jumps to `from` and continues
     * from there, so history beyond the page cap is reached over several
     * connects. Pass `to` already reduced by any slack.
     */
    resume?: ReadonlyMap<string, BackfillProgress>;
    /** Stops paging once aborted; unfinished relays then report `failed`. */
    signal?: AbortSignal;
    /**
     * Trust gate applied to each event before copies are de-duplicated by id:
     * an accepted copy always wins over a rejected one with the same id, so an
     * unverified copy can never replace or suppress a genuine event. A rejected
     * event is still returned when no accepted copy was fetched, for the caller
     * to report. Defaults to accepting every event.
     */
    accept?: (event: NostrEvent) => boolean;
}
/** How one relay's paged walk ended. */
export type RelayBackfillOutcome = {
    relay: string;
    status: "complete";
}
/** Hit `maxPages`; `until` is where the walk stopped (inclusive). */
 | {
    relay: string;
    status: "capped";
    until: number;
}
/**
 * A single second filled a page that may have been truncated at the relay's
 * result cap, so some of its events may have been skipped (timestamp-only
 * paging cannot enumerate them).
 */
 | {
    relay: string;
    status: "saturated";
}
/**
 * The request failed, was aborted, or the relay answered outside the
 * requested `since`/`until` window.
 */
 | {
    relay: string;
    status: "failed";
};
/** Result of {@link fetchPagedBackfill}. */
export interface PagedBackfillResult {
    /**
     * All distinct events fetched, across every relay. For an id fetched both
     * as an accepted and a rejected copy (see `accept`), only an accepted copy.
     */
    events: NostrEvent[];
    /**
     * True when every relay was paged down to `since` (or its oldest event).
     * False when a relay hit `maxPages`, saturated a second, or failed; the
     * caller must then not advance its cursor, since older events may be
     * missing.
     */
    complete: boolean;
    /** Per-relay outcome, in `relays` order. */
    relays: RelayBackfillOutcome[];
    /** The accepted events each relay returned (see `accept`). */
    relayEvents: ReadonlyMap<string, readonly NostrEvent[]>;
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
export declare function fetchPagedBackfill(network: NostrNetworkInterface, relays: string[], filter: Filter, options: PagedBackfillOptions): Promise<PagedBackfillResult>;
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
export declare function nextBackfillCursor(options: {
    ingested: NostrEvent[];
    held: readonly NostrEvent[];
    retained?: readonly NostrEvent[];
    previous: number | undefined;
    nowSeconds: number;
}): number | undefined;
/** The oldest `created_at` among `events` at or after `from`, if any. */
export declare function oldestCreatedAt(events: readonly NostrEvent[], from?: number): number | undefined;
