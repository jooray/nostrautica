/** @module @category Extra */
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { Filter } from "applesauce-core/helpers/filter";
import type { GroupHistoryFactory } from "../client/group/marmot-group.js";
import { GroupRumorHistory, type GroupRumorHistoryBackend } from "../client/group/group-rumor-history.js";
import type { GenericKeyValueStore } from "../utils/key-value.js";
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
export declare class KeyValueRumorHistoryBackend implements GroupRumorHistoryBackend {
    private readonly store;
    constructor(store: GenericKeyValueStore<Rumor>);
    /** Load all stored rumors matching `filters`, ordered newest-first. */
    queryRumors(filters: Filter | Filter[]): Promise<Rumor[]>;
    /** Save a rumor, keyed by its id so duplicate ingests overwrite in place. */
    addRumor(rumor: Rumor): Promise<void>;
    /** Remove every stored rumor. */
    clear(): Promise<void>;
}
/**
 * Convenience helper that builds a {@link GroupHistoryFactory} producing
 * {@link GroupRumorHistory} instances backed by a per-group
 * {@link KeyValueRumorHistoryBackend}.
 *
 * @param storeFor - returns the (group-scoped) key-value store for a group id
 */
export declare function makeKeyValueRumorHistoryFactory(storeFor: (groupId: Uint8Array) => GenericKeyValueStore<Rumor>): GroupHistoryFactory<GroupRumorHistory>;
