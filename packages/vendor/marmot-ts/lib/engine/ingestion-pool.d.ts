/** @module @category Engine */
/** One pooled envelope awaiting a retained state that can decrypt it. */
export interface PooledEntry<TEnvelope> {
    /** Stable transport id (kind-445 event id) — the pool key. */
    id: string;
    /** The raw undecryptable envelope. */
    envelope: TEnvelope;
    /** The canonical tip epoch when the envelope was first pooled. */
    arrivalEpoch: number;
    /**
     * History-tree node tags this entry has already been peeled against without
     * success, so the tree-targeted sweep tries each `(event, node)` pair once.
     */
    triedTags: Set<string>;
}
/** Tuning for {@link IngestionPool}. */
export interface IngestionPoolOptions {
    /** Max entries; the oldest is evicted when the pool overflows. */
    maxSize?: number;
    /**
     * Max epochs an entry may linger: it is dropped once the canonical tip has
     * advanced more than this many epochs past the entry's arrival without the
     * entry becoming decryptable. Bounds undecryptable garbage.
     */
    maxEpochAge?: number;
}
/**
 * A persistent pool of incoming events that could not yet be decrypted against
 * any tried state (Marmot v2 `protocol-core/inbound-processing.md` "deferred").
 *
 * Transport delivers events roughly chronologically, so a message from a newer
 * epoch routinely arrives before the commit that unlocks its epoch key — and a
 * fork/old-epoch message may arrive long after. Rather than dropping these as
 * terminally unreadable, the engine holds them here and retries as the history
 * tree grows (a new commit reaches their epoch, or a retained fork state is
 * tried). Bounded by size and epoch-age so genuinely-undecryptable garbage
 * (foreign or spam kind-445 events) cannot grow it without limit.
 */
export declare class IngestionPool<TEnvelope> {
    #private;
    constructor(options?: IngestionPoolOptions);
    /** Number of pooled entries. */
    get size(): number;
    /** Whether an entry with this id is pooled. */
    has(id: string): boolean;
    /**
     * Pools an envelope (keyed by id). A re-pooled entry keeps its original
     * `arrivalEpoch` so eviction ages from first sighting. Evicts the oldest entry
     * when over `maxSize`.
     */
    add(id: string, envelope: TEnvelope, arrivalEpoch: number): void;
    /** Removes an entry (it was read, or is being given up). */
    remove(id: string): void;
    /** The pooled envelopes, oldest-first. */
    envelopes(): TEnvelope[];
    /** All pooled entries, oldest-first. */
    entries(): PooledEntry<TEnvelope>[];
    /**
     * Drops and returns entries the tip has aged past `maxEpochAge` without
     * resolving — they are unlikely to ever decrypt (foreign/garbage or an
     * unreachably-far-future epoch), so they become terminally unreadable.
     */
    evictStale(currentEpoch: number): PooledEntry<TEnvelope>[];
}
