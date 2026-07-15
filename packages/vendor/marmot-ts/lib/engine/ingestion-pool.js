/** @module @category Engine */
const DEFAULT_MAX_SIZE = 1000;
const DEFAULT_MAX_EPOCH_AGE = 256;
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
export class IngestionPool {
    #entries = new Map();
    #maxSize;
    #maxEpochAge;
    constructor(options) {
        this.#maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
        this.#maxEpochAge = options?.maxEpochAge ?? DEFAULT_MAX_EPOCH_AGE;
    }
    /** Number of pooled entries. */
    get size() {
        return this.#entries.size;
    }
    /** Whether an entry with this id is pooled. */
    has(id) {
        return this.#entries.has(id);
    }
    /**
     * Pools an envelope (keyed by id). A re-pooled entry keeps its original
     * `arrivalEpoch` so eviction ages from first sighting. Evicts the oldest entry
     * when over `maxSize`.
     */
    add(id, envelope, arrivalEpoch) {
        const existing = this.#entries.get(id);
        if (existing)
            return; // keep original arrival epoch + tried-tag memo
        this.#entries.set(id, {
            id,
            envelope,
            arrivalEpoch,
            triedTags: new Set(),
        });
        if (this.#entries.size > this.#maxSize) {
            const oldest = this.#entries.keys().next().value;
            if (oldest !== undefined)
                this.#entries.delete(oldest);
        }
    }
    /** Removes an entry (it was read, or is being given up). */
    remove(id) {
        this.#entries.delete(id);
    }
    /** The pooled envelopes, oldest-first. */
    envelopes() {
        return [...this.#entries.values()].map((e) => e.envelope);
    }
    /** All pooled entries, oldest-first. */
    entries() {
        return [...this.#entries.values()];
    }
    /**
     * Drops and returns entries the tip has aged past `maxEpochAge` without
     * resolving — they are unlikely to ever decrypt (foreign/garbage or an
     * unreachably-far-future epoch), so they become terminally unreadable.
     */
    evictStale(currentEpoch) {
        const evicted = [];
        for (const entry of this.#entries.values()) {
            if (currentEpoch - entry.arrivalEpoch > this.#maxEpochAge)
                evicted.push(entry);
        }
        for (const entry of evicted)
            this.#entries.delete(entry.id);
        return evicted;
    }
}
//# sourceMappingURL=ingestion-pool.js.map