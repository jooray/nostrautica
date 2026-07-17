/** @module @category Client - Group Manager */
import { bytesToHex } from "@noble/hashes/utils.js";
import { hexToBytes } from "applesauce-core/helpers";
import { EventEmitter } from "eventemitter3";
import { defaultCryptoProvider } from "ts-mls";
import { deserializeClientState, } from "../core/client-state.js";
import { DEFAULT_CONVERGENCE_POLICY, } from "../core/convergence.js";
import { GroupHistoryTree } from "../engine/history-tree.js";
import { RetainedHistoryStore } from "../engine/retained-store.js";
import { logger } from "../utils/debug.js";
import { MarmotGroup, } from "./group/marmot-group.js";
const log = logger.extend("GroupRegistry");
/**
 * Owns the in-memory cache of {@link MarmotGroup} instances and the
 * store-backed read/hydrate path: caching, per-group destroy listeners,
 * concurrent-load deduplication, and group construction from a
 * {@link ClientState}. The orchestrating {@link GroupsManager} layers the
 * higher-level lifecycle events (created/imported/joined/destroyed/left) on top.
 */
export class GroupRegistry extends EventEmitter {
    store;
    rewindStore;
    signer;
    network;
    audit;
    auditContext;
    cryptoProvider;
    historyFactory;
    mediaFactory;
    convergencePolicy;
    ingestionPool;
    /** In-memory cache of loaded group instances, keyed by hex group id */
    #groups = new Map();
    /** Per-group listener handles, so we can detach them when a group is unloaded. */
    #groupListeners = new Map();
    /** Tracks in-flight group loads to prevent duplicate instances under concurrency */
    #groupLoadPromises = new Map();
    constructor(options) {
        super();
        this.store = options.store;
        this.rewindStore = options.rewindStore;
        this.signer = options.signer;
        this.network = options.network;
        this.audit = options.audit;
        this.auditContext = options.auditContext;
        this.cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
        this.historyFactory =
            options.historyFactory;
        this.mediaFactory = options.mediaFactory;
        this.convergencePolicy = options.convergencePolicy;
        this.ingestionPool = options.ingestionPool;
    }
    /** Returns the list of currently loaded (cached) group instances. */
    get loaded() {
        return Array.from(this.#groups.values());
    }
    /** Reads the cached instance for a group id, without loading from the store. */
    peek(groupId) {
        const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
        return this.#groups.get(id);
    }
    /** Builds a group instance from a {@link ClientState} (not cached). */
    async build(state, retained, historyTree) {
        return MarmotGroup.fromClientState(state, {
            store: this.store,
            rewindStore: this.rewindStore,
            retained,
            historyTree,
            convergencePolicy: this.convergencePolicy,
            ingestionPool: this.ingestionPool,
            signer: this.signer,
            cryptoProvider: this.cryptoProvider,
            network: this.network,
            audit: this.audit,
            auditContext: this.auditContext,
            history: this.historyFactory,
            media: this.mediaFactory,
        });
    }
    /** Loads a group from the store, hydrated but not cached. */
    async load(groupId) {
        const id = typeof groupId === "string" ? hexToBytes(groupId) : groupId;
        const idHex = bytesToHex(id);
        log("loading group %s from store", idHex);
        const stateBytes = await this.store.getItem(idHex);
        if (!stateBytes)
            throw new Error(`Group ${idHex} not found`);
        const state = deserializeClientState(stateBytes);
        const historyTree = await this.#loadHistory(idHex, state);
        // The bounded convergence window is derived from the tree (the single
        // persisted source), never stored separately.
        const retained = historyTree
            ? await this.#retainedFromTree(historyTree, state)
            : undefined;
        return this.build(state, retained, historyTree);
    }
    /**
     * Rehydrates the full-fork history tree for a group, or `undefined` to start
     * fresh. Discards a tree that does not contain the loaded tip state as a node
     * (a torn write), so a fresh tree is seeded from the tip instead.
     */
    async #loadHistory(idHex, state) {
        if (!this.rewindStore)
            return undefined;
        try {
            const tree = await GroupHistoryTree.load(this.rewindStore, idHex);
            if (!tree)
                return undefined;
            const tipTag = bytesToHex(state.confirmationTag);
            if (!tree.hasNode(tipTag)) {
                log("discarding stale history tree for %s (missing tip node)", idHex);
                return undefined;
            }
            return tree;
        }
        catch (error) {
            log("failed to rehydrate history tree for %s: %o", idHex, error);
            return undefined;
        }
    }
    /**
     * Rebuilds the bounded convergence window from the tree's canonical path
     * (root → the loaded tip), so fork recovery has the sync access it needs. Only
     * the last `maxRewindCommits` epochs are materialized (the whole path when the
     * horizon is infinite); `record` prunes anything older. Returns `undefined` if
     * the path or any snapshot/commit is missing.
     */
    async #retainedFromTree(tree, state) {
        const tipTag = bytesToHex(state.confirmationTag);
        const fullPath = tree.path(tipTag);
        if (!fullPath || fullPath.length === 0)
            return undefined;
        const horizon = this.convergencePolicy?.maxRewindCommits ??
            DEFAULT_CONVERGENCE_POLICY.maxRewindCommits;
        const keep = Number.isFinite(horizon)
            ? Math.max(1, horizon + 1)
            : fullPath.length;
        const path = fullPath.slice(-keep);
        const states = [];
        for (const tag of path) {
            const s = await tree.stateAt(tag);
            if (!s)
                return undefined;
            states.push(s);
        }
        const retained = new RetainedHistoryStore(states[0], this.convergencePolicy);
        for (let i = 1; i < path.length; i++) {
            const commit = await tree.commitMessageOf(path[i]);
            if (!commit)
                return undefined;
            retained.record(states[i - 1], commit, states[i]);
        }
        return retained;
    }
    /** Caches a group instance and subscribes to its destroy event. */
    track(group) {
        const id = bytesToHex(group.id);
        this.#groups.set(id, group);
        // If a group self-destroys, drop it from the cache so `loaded` stays accurate.
        const destroyed = () => this.untrack(id);
        group.on("destroyed", destroyed);
        // Involuntary removal keeps the tombstone (group stays tracked); forward the
        // signal so the manager can re-emit it to the application.
        const removed = () => this.emit("removed", group);
        group.on("removed", removed);
        this.#groupListeners.set(id, { destroyed, removed });
        this.emit("updated", this.loaded);
    }
    /** Removes a group instance from the cache and detaches its listeners. */
    untrack(groupId) {
        const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
        const existing = this.#groups.get(id);
        if (!existing)
            return;
        const listeners = this.#groupListeners.get(id);
        if (listeners) {
            existing.off("destroyed", listeners.destroyed);
            existing.off("removed", listeners.removed);
            this.#groupListeners.delete(id);
        }
        // Release the settle-check timer + any queued outbound so an unloaded
        // instance leaves nothing pending (B5).
        existing.dispose();
        this.#groups.delete(id);
        this.emit("updated", this.loaded);
    }
    /** Lists all persisted group IDs, decoded from their hex storage keys. */
    async listIds() {
        const keys = await this.store.keys();
        return keys.map((key) => hexToBytes(key));
    }
    /** Checks if a group exists in the backend. */
    async has(groupId) {
        const key = typeof groupId === "string" ? groupId : bytesToHex(groupId);
        const item = await this.store.getItem(key);
        return item !== null;
    }
    /** Gets a group from cache or loads it from the store, caching the result. */
    async get(groupId) {
        const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
        let group = this.#groups.get(id);
        if (!group) {
            const existingLoad = this.#groupLoadPromises.get(id);
            if (existingLoad) {
                group = await existingLoad;
            }
            else {
                const loadPromise = this.load(groupId)
                    .then((loaded) => {
                    this.track(loaded);
                    this.emit("loaded", loaded);
                    return loaded;
                })
                    .finally(() => {
                    this.#groupLoadPromises.delete(id);
                });
                this.#groupLoadPromises.set(id, loadPromise);
                group = await loadPromise;
            }
        }
        return group;
    }
    /** Loads all groups from the store and returns them. */
    async loadAll() {
        const groupIds = await this.listIds();
        return Promise.all(groupIds.map((groupId) => this.get(groupId)));
    }
}
//# sourceMappingURL=group-registry.js.map