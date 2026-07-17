import { GroupRumorHistory, } from "../client/group/group-rumor-history.js";
/**
 * A persistent {@link GroupRumorHistoryBackend} backed by any
 * {@link GenericKeyValueStore}. Each rumor is stored under its own key (the
 * rumor `id`), which makes {@link KeyValueRumorHistoryBackend.addRumor | addRumor}
 * idempotent: re-ingesting the same group message (e.g. during relay backfill)
 * re-derives the same rumor id and overwrites the identical value rather than
 * creating a duplicate timeline entry.
 *
 * Queries load every stored rumor and filter/sort in memory, so each query is
 * `O(n)` in the number of stored rumors. This is intentionally simple and is
 * good enough for client-side group history; swap in a indexed store if a group
 * accumulates enough messages for the linear scan to matter.
 */
export class KeyValueRumorHistoryBackend {
    store;
    constructor(store) {
        this.store = store;
    }
    /** Load all stored rumors matching `filters`, ordered newest-first. */
    async queryRumors(filters) {
        const filtersArray = Array.isArray(filters) ? filters : [filters];
        const keys = await this.store.keys();
        const stored = await Promise.all(keys.map((key) => this.store.getItem(key)));
        const seen = new Set();
        const results = [];
        for (const rumor of stored) {
            if (!rumor || seen.has(rumor.id))
                continue;
            if (matchesAny(rumor, filtersArray)) {
                seen.add(rumor.id);
                results.push(rumor);
            }
        }
        // newest-first
        results.sort((a, b) => b.created_at - a.created_at);
        // Apply the tightest `limit` across the filters (mirrors nostr `limit`
        // semantics closely enough for the single-filter calls the history makes).
        const limit = Math.min(...filtersArray.map((filter) => filter.limit ?? Infinity));
        return Number.isFinite(limit) ? results.slice(0, limit) : results;
    }
    /** Save a rumor, keyed by its id so duplicate ingests overwrite in place. */
    async addRumor(rumor) {
        await this.store.setItem(rumor.id, rumor);
    }
    /** Remove every stored rumor. */
    async clear() {
        await this.store.clear();
    }
}
/** Returns true when `rumor` matches at least one of the provided filters. */
function matchesAny(rumor, filters) {
    return filters.some((filter) => matchesFilter(rumor, filter));
}
/**
 * Matches a rumor against the `kinds`/`authors`/`since`/`until` members of a
 * filter. `since`/`until` are inclusive bounds on `created_at`. `limit` is
 * applied by the caller after sorting, not here.
 */
function matchesFilter(rumor, filter) {
    if (filter.kinds && !filter.kinds.includes(rumor.kind))
        return false;
    if (filter.authors && !filter.authors.includes(rumor.pubkey))
        return false;
    if (filter.since !== undefined && rumor.created_at < filter.since)
        return false;
    if (filter.until !== undefined && rumor.created_at > filter.until)
        return false;
    return true;
}
/**
 * Convenience helper that builds a {@link GroupHistoryFactory} producing
 * {@link GroupRumorHistory} instances backed by a per-group
 * {@link KeyValueRumorHistoryBackend}.
 *
 * @param storeFor - returns the (group-scoped) key-value store for a group id
 */
export function makeKeyValueRumorHistoryFactory(storeFor) {
    return GroupRumorHistory.makeFactory((groupId) => new KeyValueRumorHistoryBackend(storeFor(groupId)));
}
//# sourceMappingURL=key-value-rumor-history-backend.js.map