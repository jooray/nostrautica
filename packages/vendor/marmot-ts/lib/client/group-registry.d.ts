import { EventSigner } from "applesauce-core";
import { EventEmitter } from "eventemitter3";
import { ClientState, CryptoProvider } from "ts-mls";
import { SerializedClientState } from "../core/client-state.js";
import { type ConvergencePolicy } from "../core/convergence.js";
import { GroupHistoryTree } from "../engine/history-tree.js";
import type { IngestionPoolOptions } from "../engine/ingestion-pool.js";
import type { AuditContextOptions, AuditSink } from "../audit/index.js";
import { RetainedHistoryStore } from "../engine/retained-store.js";
import type { GenericKeyValueStore } from "../utils/key-value.js";
import { BaseGroupHistory, BaseGroupMedia, GroupHistoryFactory, GroupMediaFactory, MarmotGroup } from "./group/marmot-group.js";
import type { NostrNetworkInterface } from "./nostr-interface.js";
/** Options accepted by {@link GroupRegistry}. */
export type GroupRegistryOptions<THistory extends BaseGroupHistory | undefined = undefined, TMedia extends BaseGroupMedia | undefined = undefined> = {
    store: GenericKeyValueStore<SerializedClientState>;
    /** Dedicated store for the per-group full-fork history tree (optional). */
    rewindStore?: GenericKeyValueStore<Uint8Array>;
    signer: EventSigner;
    network: NostrNetworkInterface;
    /** Optional forensic audit sink inherited by loaded groups. */
    audit?: AuditSink;
    /** Required when `audit` is set; contains stable engine/account/session metadata. */
    auditContext?: AuditContextOptions;
    cryptoProvider?: CryptoProvider;
    historyFactory?: GroupHistoryFactory<THistory>;
    mediaFactory?: GroupMediaFactory<TMedia>;
    /** Convergence policy applied to loaded groups (rollback horizon, selection). */
    convergencePolicy?: ConvergencePolicy;
    /** Ingestion-pool tuning applied to loaded groups (size + epoch-age bounds). */
    ingestionPool?: IngestionPoolOptions;
};
/** Cache-level events emitted by {@link GroupRegistry}. */
export type GroupRegistryEvents<THistory extends BaseGroupHistory | undefined = any, TMedia extends BaseGroupMedia | undefined = any> = {
    /** Emitted when the set of loaded (cached) groups changes. */
    updated: (groups: MarmotGroup<THistory, TMedia>[]) => void;
    /** Emitted when a group is loaded from the store into the cache. */
    loaded: (group: MarmotGroup<THistory, TMedia>) => void;
    /** Emitted when an inbound commit removed the client from a tracked group. */
    removed: (group: MarmotGroup<THistory, TMedia>) => void;
};
/**
 * Owns the in-memory cache of {@link MarmotGroup} instances and the
 * store-backed read/hydrate path: caching, per-group destroy listeners,
 * concurrent-load deduplication, and group construction from a
 * {@link ClientState}. The orchestrating {@link GroupsManager} layers the
 * higher-level lifecycle events (created/imported/joined/destroyed/left) on top.
 */
export declare class GroupRegistry<THistory extends BaseGroupHistory | undefined = any, TMedia extends BaseGroupMedia | undefined = any> extends EventEmitter<GroupRegistryEvents<THistory, TMedia>> {
    #private;
    readonly store: GenericKeyValueStore<SerializedClientState>;
    readonly rewindStore?: GenericKeyValueStore<Uint8Array>;
    readonly signer: EventSigner;
    readonly network: NostrNetworkInterface;
    readonly audit?: AuditSink;
    readonly auditContext?: AuditContextOptions;
    readonly cryptoProvider: CryptoProvider;
    readonly historyFactory: GroupHistoryFactory<THistory>;
    readonly mediaFactory: GroupMediaFactory<TMedia>;
    readonly convergencePolicy?: ConvergencePolicy;
    readonly ingestionPool?: IngestionPoolOptions;
    constructor(options: GroupRegistryOptions<THistory, TMedia>);
    /** Returns the list of currently loaded (cached) group instances. */
    get loaded(): MarmotGroup<THistory, TMedia>[];
    /** Reads the cached instance for a group id, without loading from the store. */
    peek(groupId: Uint8Array | string): MarmotGroup<THistory, TMedia> | undefined;
    /** Builds a group instance from a {@link ClientState} (not cached). */
    build(state: ClientState, retained?: RetainedHistoryStore, historyTree?: GroupHistoryTree): Promise<MarmotGroup<THistory, TMedia>>;
    /** Loads a group from the store, hydrated but not cached. */
    load(groupId: Uint8Array | string): Promise<MarmotGroup<THistory, TMedia>>;
    /** Caches a group instance and subscribes to its destroy event. */
    track(group: MarmotGroup<THistory, TMedia>): void;
    /** Removes a group instance from the cache and detaches its listeners. */
    untrack(groupId: Uint8Array | string): void;
    /** Lists all persisted group IDs, decoded from their hex storage keys. */
    listIds(): Promise<Uint8Array[]>;
    /** Checks if a group exists in the backend. */
    has(groupId: Uint8Array | string): Promise<boolean>;
    /** Gets a group from cache or loads it from the store, caching the result. */
    get(groupId: Uint8Array | string): Promise<MarmotGroup<THistory, TMedia>>;
    /** Loads all groups from the store and returns them. */
    loadAll(): Promise<MarmotGroup<THistory, TMedia>[]>;
}
