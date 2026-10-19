/** @module @category Engine */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decode, encode, mlsMessageDecoder, mlsMessageEncoder, } from "../vendor/ts-mls/index.js";
import { BinaryReader, BinaryWriter } from "../core/binary.js";
import { deserializeClientState, serializeClientState, } from "../core/client-state.js";
import { commitDigest } from "../core/convergence.js";
import { decodeOwnCommitRecord, encodeOwnCommitRecord, } from "./own-commit-stamp.js";
import { projectHistoricalReceivers, retainedTopology, } from "./retention.js";
function retentionPlanIdentity(plan) {
    return bytesToHex(commitDigest(new TextEncoder().encode(JSON.stringify({
        revision: plan.revision,
        canonicalTipTag: plan.canonicalTipTag,
        rootTag: plan.logicalRootTag,
        tipEpoch: plan.tipEpoch,
        floorEpoch: plan.floorEpoch,
        appFloorEpoch: plan.appFloorEpoch,
        retainedTags: plan.retainedTags,
        excludedTags: plan.excludedTags,
        receivers: [...plan.receiverEpochs],
        snapshots: [...plan.snapshots].map(([tag, bytes]) => [
            tag,
            bytesToHex(bytes),
        ]),
    }))));
}
/** Wire-format version byte for a persisted node-edge / meta record. */
const HISTORY_TREE_VERSION = 1;
/** Default number of heavy snapshots kept rehydrated in memory at once. */
const DEFAULT_SNAPSHOT_CACHE = 128;
const metaKey = (gid) => `${gid}/meta`;
const edgeKey = (gid, tag) => `${gid}/edge/${tag}`;
const stateKey = (gid, tag) => `${gid}/state/${tag}`;
const commitKey = (gid, tag) => `${gid}/commit/${tag}`;
/**
 * The retained group history tree (Marmot v2 full-fork history). Holds every
 * retained group state — the canonical branch and eligible forks — as a tree
 * of {@link ClientState} snapshots linked by commit edges. Settled retention
 * publishes authoritative membership before removing obsolete physical keys.
 *
 * The **light index** (per-node epoch/parent/edge metadata) is always resident.
 * **Heavy material** (serialized snapshots + commit bytes) is kept in a bounded
 * in-memory LRU and otherwise fetched from a backing key-value store on demand,
 * so memory stays bounded even as the tree grows without limit. Newly recorded
 * nodes are pinned in memory until {@link flush} persists them.
 *
 * Snapshots are stored as bytes, never as live `ClientState` objects: ts-mls
 * zeroes a parent state's consumed secrets in place when a commit is processed
 * from it, so a retained live object could be corrupted out from under a
 * sibling-branch replay. Re-deriving a state ({@link stateAt}) decodes a fresh,
 * independent object every call.
 */
export class GroupHistoryTree {
    /** The resident light index — node metadata, always in memory. */
    #nodes = new Map();
    /** Bounded LRU of heavy material; dirty (unflushed) entries are never evicted. */
    #heavy = new Map();
    /** Tags whose light + heavy material has not yet been flushed to the store. */
    #dirty = new Map();
    #revision = 0;
    #publishedRetention;
    #checkpoint;
    #retentionActive = false;
    #flushing;
    /** Max heavy entries kept resident (excluding pinned dirty entries). */
    #cacheMax;
    /** The root node tag, or `undefined` while the tree is empty. */
    #rootTag;
    /** Hex group id, derived from the root state; the persistence key prefix. */
    #gid;
    /** Whether the root pointer (meta) needs flushing. */
    #rootDirty = false;
    /** Backing store for heavy material, once bound. */
    #store;
    /** Seeds an empty tree, optionally with a root {@link ClientState}. */
    constructor(root, options) {
        this.#cacheMax = options?.snapshotCacheSize ?? DEFAULT_SNAPSHOT_CACHE;
        if (root)
            this.setRoot(root);
    }
    /** Logical retained root tag, or `undefined` if empty. */
    get rootTag() {
        return this.#rootTag;
    }
    /** Number of nodes (states) retained in the tree. */
    get size() {
        return this.#nodes.size;
    }
    /** Oldest epoch still named by the tree, or `undefined` when it is empty. */
    oldestEpoch() {
        let oldest;
        for (const node of this.#nodes.values())
            if (oldest === undefined || node.epoch < oldest)
                oldest = node.epoch;
        return oldest;
    }
    /** Whether unflushed changes are pending. */
    get isDirty() {
        return this.#dirty.size > 0 || this.#rootDirty;
    }
    /**
     * Sets the root from a {@link ClientState}. The root carries no commit edge.
     * Throws if a different root is already set (a tree has exactly one root).
     */
    setRoot(state) {
        this.#assertMutable();
        const tag = bytesToHex(state.confirmationTag);
        if (this.#rootTag !== undefined && this.#rootTag !== tag) {
            throw new Error("GroupHistoryTree: root already set to a different node");
        }
        if (!this.#nodes.has(tag)) {
            this.#nodes.set(tag, {
                tag,
                epoch: Number(state.groupContext.epoch),
                childTags: [],
            });
            this.#markDirty(tag);
            this.#putHeavy(tag, { snapshot: serializeClientState(state) });
        }
        this.#rootTag = tag;
        this.#gid = bytesToHex(state.groupContext.groupId);
        this.#rootDirty = true;
        return tag;
    }
    /** Whether a node with `tag` exists. */
    hasNode(tag) {
        return this.#nodes.has(tag);
    }
    /** Returns a read-only view of a node, or `undefined` if absent. */
    node(tag) {
        const n = this.#nodes.get(tag);
        if (!n)
            return undefined;
        return {
            tag: n.tag,
            epoch: n.epoch,
            parentTag: n.parentTag,
            childTags: [...n.childTags],
            edge: n.edge,
        };
    }
    /** All node tags, in insertion order. */
    tags() {
        return [...this.#nodes.keys()];
    }
    /** The epoch of a node, or `undefined` if absent. */
    epochOf(tag) {
        return this.#nodes.get(tag)?.epoch;
    }
    /** The parent tag of a node, or `undefined` for the root / absent node. */
    parentOf(tag) {
        return this.#nodes.get(tag)?.parentTag;
    }
    /** Child tags of a node (empty for a tip or an absent node). */
    childrenOf(tag) {
        const n = this.#nodes.get(tag);
        return n ? [...n.childTags] : [];
    }
    /** Whether a node is a tip (exists and has no children). */
    isTip(tag) {
        const n = this.#nodes.get(tag);
        return n !== undefined && n.childTags.length === 0;
    }
    /** All tip tags (leaf states) — the candidate branches for convergence. */
    tips() {
        const out = [];
        for (const n of this.#nodes.values())
            if (n.childTags.length === 0)
                out.push(n.tag);
        return out;
    }
    /** All node tags sitting at `epoch`. */
    nodesAtEpoch(epoch) {
        const out = [];
        for (const n of this.#nodes.values())
            if (n.epoch === epoch)
                out.push(n.tag);
        return out;
    }
    /**
     * The path from the root to `tag` (inclusive of both), or `undefined` if the
     * node is absent or its chain to the root is broken.
     */
    path(tag) {
        const out = [];
        let cursor = tag;
        const seen = new Set();
        while (cursor !== undefined) {
            if (seen.has(cursor))
                return undefined; // cycle guard (should never happen)
            seen.add(cursor);
            const n = this.#nodes.get(cursor);
            if (!n)
                return undefined;
            out.push(cursor);
            cursor = n.parentTag;
        }
        out.reverse();
        return out;
    }
    /** Ancestor tags of a node, nearest-first (excludes the node itself). */
    ancestors(tag) {
        const full = this.path(tag);
        if (!full)
            return [];
        // path is root..tag; drop the node itself and reverse to nearest-first.
        return full.slice(0, -1).reverse();
    }
    /**
     * The lowest common ancestor of two nodes (the fork point), or `undefined` if
     * they share no ancestor (e.g. live in different trees).
     */
    lowestCommonAncestor(a, b) {
        const pathA = this.path(a);
        if (!pathA)
            return undefined;
        const ancestorsA = new Set(pathA);
        let cursor = b;
        while (cursor !== undefined) {
            if (ancestorsA.has(cursor))
                return cursor;
            cursor = this.#nodes.get(cursor)?.parentTag;
        }
        return undefined;
    }
    /**
     * The serialized `ClientState` snapshot bytes for a node, or `undefined` if
     * absent. Served from the in-memory cache, else fetched from the store.
     */
    async snapshotOf(tag) {
        if (!this.#nodes.has(tag))
            return undefined;
        const cached = this.#heavy.get(tag);
        if (cached) {
            this.#touch(tag);
            return cached.snapshot;
        }
        if (!this.#store || !this.#gid)
            return undefined;
        const projection = this.#checkpoint?.projections[tag];
        if (projection !== undefined) {
            const bytes = hexToBytes(projection);
            this.#putHeavy(tag, { snapshot: bytes });
            return bytes;
        }
        const bytes = await this.#store.getItem(stateKey(this.#gid, tag));
        if (!bytes)
            return undefined;
        this.#putHeavy(tag, { snapshot: bytes });
        return bytes;
    }
    /**
     * Rehydrates a node's state into a fresh, independent {@link ClientState}, or
     * `undefined` if no snapshot is retained. Each call decodes a new object, so
     * callers may mutate/advance it without affecting the tree.
     */
    async stateAt(tag) {
        const bytes = await this.snapshotOf(tag);
        return bytes ? deserializeClientState(bytes) : undefined;
    }
    /** The serialized commit bytes that produced a node, or `undefined`. */
    async commitBytesOf(childTag) {
        const node = this.#nodes.get(childTag);
        if (!node || !node.edge)
            return undefined;
        const cached = this.#heavy.get(childTag);
        if (cached?.commit) {
            this.#touch(childTag);
            return decodeOwnCommitRecord(cached.commit).wireBytes;
        }
        if (!this.#store || !this.#gid)
            return undefined;
        // Fetched on demand (rare — for replay/debug); not cached, to avoid
        // displacing a hot snapshot or polluting the LRU with commit-only entries.
        const record = await this.#store.getItem(commitKey(this.#gid, childTag));
        return record ? decodeOwnCommitRecord(record).wireBytes : undefined;
    }
    /** Confirmation-time evidence for a locally-authored commit, if stamped. */
    async ownCommitStampOf(childTag) {
        const node = this.#nodes.get(childTag);
        if (!node || !node.edge)
            return undefined;
        const cached = this.#heavy.get(childTag)?.commit;
        const record = cached ??
            (this.#store && this.#gid
                ? await this.#store.getItem(commitKey(this.#gid, childTag))
                : null);
        if (!record)
            return undefined;
        const decoded = decodeOwnCommitRecord(record);
        return decoded.kind === "stamped" ? decoded.stamp : undefined;
    }
    /** Decodes the commit `MlsMessage` that produced a node, or `undefined`. */
    async commitMessageOf(childTag) {
        const bytes = await this.commitBytesOf(childTag);
        if (!bytes)
            return undefined;
        const message = decode(mlsMessageDecoder, bytes);
        if (!message)
            throw new Error("GroupHistoryTree: failed to decode commit message");
        return message;
    }
    /**
     * Records a commit applied from a retained parent node to its resulting child
     * state, adding (or linking) the child node. Idempotent on the child tag: a
     * duplicate commit re-links without overwriting. Throws if the parent is not
     * already in the tree.
     *
     * @returns the child node tag.
     */
    recordCommit(parentTag, commitMessage, childState, senderLeafIndex, ownCommitStamp) {
        this.#assertMutable();
        const parent = this.#nodes.get(parentTag);
        if (!parent)
            throw new Error(`GroupHistoryTree: parent ${parentTag.slice(0, 8)} not in tree`);
        const childTag = bytesToHex(childState.confirmationTag);
        const bytes = encode(mlsMessageEncoder, commitMessage);
        const existing = this.#nodes.get(childTag);
        if (!existing) {
            this.#nodes.set(childTag, {
                tag: childTag,
                epoch: Number(childState.groupContext.epoch),
                parentTag,
                childTags: [],
                edge: { commitDigest: commitDigest(bytes), senderLeafIndex },
            });
            this.#markDirty(childTag);
            this.#putHeavy(childTag, {
                snapshot: serializeClientState(childState),
                commit: ownCommitStamp
                    ? encodeOwnCommitRecord({ wireBytes: bytes, stamp: ownCommitStamp })
                    : bytes,
            });
        }
        else {
            if (existing.parentTag !== parentTag ||
                !existing.edge ||
                bytesToHex(existing.edge.commitDigest) !==
                    bytesToHex(commitDigest(bytes)))
                throw new Error("GroupHistoryTree: existing child has conflicting parent or commit");
            // Confirmation can follow an earlier observation of the same edge. In
            // that case preserve idempotence while upgrading the bare wire record to
            // durable confirmation-time evidence. Never replace an existing stamp.
            const cached = this.#heavy.get(childTag);
            const decoded = cached?.commit
                ? decodeOwnCommitRecord(cached.commit)
                : undefined;
            if (ownCommitStamp && decoded?.kind === "legacy") {
                this.#markDirty(childTag);
                this.#putHeavy(childTag, {
                    snapshot: cached.snapshot,
                    commit: encodeOwnCommitRecord({
                        wireBytes: bytes,
                        stamp: ownCommitStamp,
                    }),
                });
            }
        }
        if (!parent.childTags.includes(childTag))
            parent.childTags.push(childTag);
        return childTag;
    }
    /**
     * Records an edge from a snapshot captured at branch-build time. Unlike
     * {@link recordCommit}, the child snapshot is supplied pre-serialized — fork
     * recovery serializes each branch state the instant it is produced, before
     * ts-mls can zero that state's secrets when exploring its children. Idempotent
     * on the child tag. Returns `false` (without recording) when the parent is not
     * yet in the tree, so a batch can skip a dangling edge instead of throwing.
     */
    recordEdge(edge) {
        this.#assertMutable();
        const parent = this.#nodes.get(edge.parentTag);
        if (!parent)
            return false;
        if (!this.#nodes.has(edge.childTag)) {
            this.#nodes.set(edge.childTag, {
                tag: edge.childTag,
                epoch: edge.childEpoch,
                parentTag: edge.parentTag,
                childTags: [],
                edge: {
                    commitDigest: edge.commitDigest,
                    senderLeafIndex: edge.senderLeafIndex,
                },
            });
            this.#markDirty(edge.childTag);
            this.#putHeavy(edge.childTag, {
                snapshot: edge.childSnapshot,
                commit: edge.commitBytes,
            });
        }
        if (!parent.childTags.includes(edge.childTag))
            parent.childTags.push(edge.childTag);
        return true;
    }
    /**
     * Replaces a node's retained snapshot — used after staging a proposal onto a
     * node, which updates its `unappliedProposals` without advancing the epoch.
     * The new state's confirmation tag MUST equal the node tag (staging a proposal
     * does not change it). Throws if the node is absent or the tag would change.
     */
    updateSnapshot(tag, state) {
        this.#assertMutable();
        const node = this.#nodes.get(tag);
        if (!node)
            throw new Error(`GroupHistoryTree: cannot update absent node ${tag.slice(0, 8)}`);
        const stateTag = bytesToHex(state.confirmationTag);
        if (stateTag !== tag)
            throw new Error("GroupHistoryTree: updateSnapshot would change the node identity");
        const existing = this.#heavy.get(tag);
        this.#markDirty(tag);
        this.#putHeavy(tag, {
            snapshot: serializeClientState(state),
            commit: existing?.commit,
        });
    }
    /**
     * Binds a backing store to a fresh, in-memory tree so its nodes can be flushed
     * and its heavy material later evicted/reloaded. Marks every current node
     * dirty so the first {@link flush} persists the whole tree. A no-op if the
     * same store is already bound (e.g. on a tree loaded via {@link load}).
     */
    bindStore(store) {
        this.#assertMutable();
        if (this.#store === store)
            return;
        this.#store = store;
        this.#rootDirty = true;
        for (const tag of this.#nodes.keys())
            this.#markDirty(tag);
    }
    /**
     * Persists all unflushed nodes incrementally: each dirty node's light edge
     * record, snapshot, and commit bytes are written under its own keys, plus the
     * meta (root) record. Append-only — already-persisted nodes are untouched, so
     * a save costs O(new nodes), not O(tree). Requires a bound store.
     */
    async flush() {
        this.#assertMutable();
        if (this.#flushing)
            return this.#flushing;
        const operation = this.#flush();
        this.#flushing = operation;
        try {
            await operation;
        }
        finally {
            this.#flushing = undefined;
        }
    }
    async #flush() {
        if (!this.#store || !this.#gid)
            throw new Error("GroupHistoryTree: flush requires a bound store");
        const gid = this.#gid;
        const revision = this.#revision;
        const dirty = [...this.#dirty].map(([tag, generation]) => ({
            tag,
            generation,
            node: this.#nodes.get(tag),
            heavy: this.#heavy.get(tag),
        }));
        const checkpoint = this.#checkpoint
            ? {
                ...this.#checkpoint,
                members: this.tags(),
                garbage: this.#checkpoint.garbage.filter((tag) => !this.#nodes.has(tag)),
                receivers: { ...this.#checkpoint.receivers },
            }
            : undefined;
        for (const { tag, node, heavy } of dirty) {
            if (!node || !heavy)
                throw new Error("GroupHistoryTree: dirty material missing");
            await this.#store.setItem(edgeKey(gid, tag), this.#encodePhysicalEdge(node));
            await this.#store.setItem(stateKey(gid, tag), heavy.snapshot);
            if (node.edge) {
                const commit = heavy.commit ?? (await this.#store.getItem(commitKey(gid, tag)));
                if (!commit)
                    throw new Error("GroupHistoryTree: required commit missing");
                await this.#store.setItem(commitKey(gid, tag), commit);
            }
            if (checkpoint) {
                checkpoint.receivers[tag] = [
                    ...deserializeClientState(heavy.snapshot).historicalReceiverData.keys(),
                ].map(Number);
                checkpoint.projections = { ...checkpoint.projections };
                delete checkpoint.projections[tag];
            }
        }
        if (this.#rootTag && (this.#rootDirty || checkpoint)) {
            await this.#store.setItem(metaKey(gid), checkpoint ? encodeCheckpoint(checkpoint) : encodeMeta(this.#rootTag));
            if (checkpoint)
                this.#checkpoint = checkpoint;
            if (this.#revision === revision)
                this.#rootDirty = false;
        }
        for (const { tag, generation } of dirty)
            if (this.#dirty.get(tag) === generation)
                this.#dirty.delete(tag);
        // Flushed entries are now clean and may be evicted under cache pressure.
        this.#evict();
    }
    /**
     * Loads a tree's light index from a store (heavy material stays lazy). Returns
     * `undefined` if no tree is persisted under `gid`. The store stays bound, so
     * snapshots/commit bytes are fetched on demand.
     */
    static async load(store, gid, options) {
        const metaBytes = await store.getItem(metaKey(gid));
        if (!metaBytes)
            return undefined;
        const checkpoint = metaBytes[0] === 2 ? decodeCheckpoint(metaBytes) : undefined;
        const rootTag = checkpoint?.rootTag ?? decodeMeta(metaBytes);
        const tree = new GroupHistoryTree(undefined, options);
        tree.#store = store;
        tree.#gid = gid;
        const prefix = `${gid}/edge/`;
        const keys = checkpoint
            ? checkpoint.members.map((tag) => edgeKey(gid, tag))
            : await store.keys();
        for (const key of keys) {
            if (!key.startsWith(prefix))
                continue;
            const tag = key.slice(prefix.length);
            const bytes = await store.getItem(key);
            if (!bytes) {
                if (checkpoint)
                    throw new Error("GroupHistoryTree: required edge missing");
                continue;
            }
            const rec = decodeEdgeRecord(bytes);
            tree.#nodes.set(tag, {
                tag,
                epoch: rec.epoch,
                parentTag: rec.parentTag,
                childTags: [],
                edge: rec.edge,
            });
        }
        // Version 1 had no child-order authority; normalize adapter enumeration.
        if (!checkpoint) {
            const ordered = [...tree.#nodes.values()].sort((a, b) => a.epoch - b.epoch || a.tag.localeCompare(b.tag));
            tree.#nodes.clear();
            for (const node of ordered)
                tree.#nodes.set(node.tag, node);
        }
        for (const node of tree.#nodes.values()) {
            if (node.parentTag)
                tree.#nodes.get(node.parentTag)?.childTags.push(node.tag);
        }
        tree.#rootTag = rootTag;
        if (checkpoint) {
            tree.#checkpoint = checkpoint;
            await tree.#validateCheckpoint(checkpoint);
            const root = tree.#nodes.get(rootTag);
            root.parentTag = undefined;
            for (const node of tree.#nodes.values())
                node.childTags = [];
            for (const node of tree.#nodes.values())
                if (node.parentTag)
                    tree.#nodes.get(node.parentTag).childTags.push(node.tag);
        }
        // Loaded nodes are already persisted — nothing dirty.
        return tree;
    }
    /** Removes every persisted key for a group's tree from the store. */
    static async purge(store, gid) {
        const keys = await store.keys();
        for (const key of keys) {
            if (key === metaKey(gid) ||
                ["edge", "state", "commit"].some((namespace) => key.startsWith(`${gid}/${namespace}/`)))
                await store.removeItem(key);
        }
    }
    /**
     * Captures one settled keep decision. Callers fence dependency admission until cleanup ends.
     * @internal
     */
    async prepareRetention(options) {
        this.#assertMutable();
        const revision = this.#revision;
        const topology = retainedTopology(this, options);
        const snapshots = new Map();
        const receiverEpochs = new Map();
        for (const tag of topology.retainedTags) {
            const bytes = await this.snapshotOf(tag);
            if (!bytes)
                throw new Error("GroupHistoryTree: required snapshot missing");
            const projected = projectHistoricalReceivers(bytes, topology.appFloorEpoch, (options.pins ?? []).filter((pin) => pin.stateTag === tag));
            snapshots.set(tag, projected.snapshot);
            receiverEpochs.set(tag, projected.receiverEpochs);
        }
        if (revision !== this.#revision)
            throw new Error("GroupHistoryTree: retention plan became stale");
        return {
            ...topology,
            revision,
            canonicalTipTag: options.canonicalTipTag,
            snapshots,
            receiverEpochs,
        };
    }
    /**
     * Flush required bytes, publish authority, then adopt; never delete before publication.
     * @internal
     */
    async publishRetention(plan) {
        this.#assertMutable();
        if (!plan.logicalRootTag)
            return;
        if (!this.#store || !this.#gid) {
            this.#publishLocalRetention(plan);
            return;
        }
        if (this.#flushing)
            await this.#flushing;
        if (plan.revision !== this.#revision)
            throw new Error("GroupHistoryTree: retention plan became stale");
        this.#retentionActive = true;
        try {
            const identity = retentionPlanIdentity(plan);
            await this.#flush();
            const root = this.#nodes.get(plan.logicalRootTag);
            const existingBoundary = plan.logicalRootTag === this.#checkpoint?.rootTag
                ? this.#checkpoint.boundary
                : undefined;
            const boundary = existingBoundary ??
                (root.parentTag && root.edge
                    ? {
                        parentTag: root.parentTag,
                        epoch: this.#nodes.get(root.parentTag).epoch,
                        digest: bytesToHex(root.edge.commitDigest),
                        senderLeafIndex: root.edge.senderLeafIndex,
                    }
                    : undefined);
            const checkpoint = {
                version: 2,
                rootTag: plan.logicalRootTag,
                members: [...plan.retainedTags],
                garbage: [
                    ...new Set([
                        ...(this.#checkpoint?.garbage ?? []),
                        ...plan.excludedTags,
                    ]),
                ],
                receivers: Object.fromEntries([...plan.receiverEpochs].map(([tag, epochs]) => [
                    tag,
                    epochs ? [...epochs] : null,
                ])),
                boundary,
                projections: Object.fromEntries([...plan.snapshots].map(([tag, bytes]) => [tag, bytesToHex(bytes)])),
            };
            // A plan object is not trusted merely because its TypeScript type matches.
            decodeCheckpoint(encodeCheckpoint(checkpoint));
            if (!checkpoint.members.includes(plan.canonicalTipTag))
                throw new Error("GroupHistoryTree: retention excludes canonical tip");
            const keep = new Set(checkpoint.members);
            for (const tag of checkpoint.members) {
                const snapshot = plan.snapshots.get(tag);
                const node = this.#nodes.get(tag);
                if (!snapshot || !node)
                    throw new Error("GroupHistoryTree: retention snapshot absent");
                const state = deserializeClientState(snapshot);
                if (bytesToHex(state.confirmationTag) !== tag ||
                    Number(state.groupContext.epoch) !== node.epoch ||
                    bytesToHex(state.groupContext.groupId) !== this.#gid)
                    throw new Error("GroupHistoryTree: retention snapshot identity mismatch");
                const allowed = checkpoint.receivers[tag];
                const actual = [...state.historicalReceiverData.keys()]
                    .map(Number)
                    .sort((a, b) => a - b);
                if (allowed !== null &&
                    actual.join() !== [...allowed].sort((a, b) => a - b).join())
                    throw new Error("GroupHistoryTree: retention receiver allowlist mismatch");
                if (tag !== checkpoint.rootTag &&
                    (!node.parentTag ||
                        !keep.has(node.parentTag) ||
                        this.#nodes.get(node.parentTag).epoch + 1 !== node.epoch))
                    throw new Error("GroupHistoryTree: retention parent closure broken");
                if (node.edge) {
                    const bytes = await this.#store.getItem(commitKey(this.#gid, tag));
                    if (!bytes ||
                        bytesToHex(commitDigest(decodeOwnCommitRecord(bytes).wireBytes)) !==
                            bytesToHex(node.edge.commitDigest))
                        throw new Error("GroupHistoryTree: retention commit mismatch");
                }
            }
            const authority = encodeCheckpoint(checkpoint);
            try {
                await this.#store.setItem(metaKey(this.#gid), authority);
            }
            catch (error) {
                const persisted = await this.#store.getItem(metaKey(this.#gid));
                if (persisted && bytesToHex(persisted) === bytesToHex(authority)) {
                    this.#adoptCheckpoint(checkpoint, plan.snapshots);
                    this.#publishedRetention = {
                        plan: new WeakRef(plan),
                        revision: this.#revision,
                        identity,
                    };
                }
                throw error;
            }
            this.#adoptCheckpoint(checkpoint, plan.snapshots);
            this.#publishedRetention = {
                plan: new WeakRef(plan),
                revision: this.#revision,
                identity,
            };
        }
        finally {
            this.#retentionActive = false;
        }
    }
    /** Process-local authority only; never advertises restart recovery. */
    #publishLocalRetention(plan) {
        if (plan.revision !== this.#revision)
            throw new Error("GroupHistoryTree: retention plan became stale");
        if (!plan.logicalRootTag ||
            !plan.retainedTags.includes(plan.canonicalTipTag))
            throw new Error("GroupHistoryTree: retention excludes canonical tip");
        const gid = bytesToHex(deserializeClientState(plan.snapshots.get(plan.canonicalTipTag))
            .groupContext.groupId);
        const keep = new Set(plan.retainedTags);
        if (keep.size !== plan.retainedTags.length ||
            this.tags().some((tag) => keep.has(tag) === plan.excludedTags.includes(tag)))
            throw new Error("GroupHistoryTree: retention membership mismatch");
        for (const tag of keep) {
            const node = this.#nodes.get(tag);
            const snapshot = plan.snapshots.get(tag);
            if (!node ||
                !snapshot ||
                (tag !== plan.logicalRootTag && !keep.has(node.parentTag)))
                throw new Error("GroupHistoryTree: retention snapshot absent");
            const state = deserializeClientState(snapshot);
            if (bytesToHex(state.confirmationTag) !== tag ||
                Number(state.groupContext.epoch) !== node.epoch ||
                bytesToHex(state.groupContext.groupId) !== gid)
                throw new Error("GroupHistoryTree: retention snapshot identity mismatch");
            const epochs = plan.receiverEpochs.get(tag);
            if (epochs !== undefined &&
                [...state.historicalReceiverData.keys()]
                    .map(Number)
                    .sort((a, b) => a - b)
                    .join() !== [...epochs].sort((a, b) => a - b).join())
                throw new Error("GroupHistoryTree: retention receiver mismatch");
        }
        const root = this.#nodes.get(plan.logicalRootTag);
        const boundary = plan.logicalRootTag === this.#checkpoint?.rootTag
            ? this.#checkpoint.boundary
            : root.parentTag && root.edge
                ? {
                    parentTag: root.parentTag,
                    epoch: this.#nodes.get(root.parentTag).epoch,
                    digest: bytesToHex(root.edge.commitDigest),
                    senderLeafIndex: root.edge.senderLeafIndex,
                }
                : undefined;
        const identity = retentionPlanIdentity(plan);
        this.#adoptCheckpoint({
            version: 2,
            rootTag: plan.logicalRootTag,
            members: [...keep],
            garbage: [],
            receivers: Object.fromEntries([...plan.receiverEpochs].map(([tag, epochs]) => [
                tag,
                epochs ? [...epochs] : null,
            ])),
            projections: {},
            boundary,
        }, plan.snapshots);
        this.#publishedRetention = {
            plan: new WeakRef(plan),
            revision: this.#revision,
            identity,
        };
        // With no adapter, the projected bytes must remain available in memory.
        for (const [tag, snapshot] of plan.snapshots)
            this.#putHeavy(tag, { snapshot, commit: this.#heavy.get(tag)?.commit });
    }
    /** @internal Exact local plan adopted from durable authority, including after-forward rejection. */
    isRetentionPublished(plan) {
        return (this.#publishedRetention?.plan.deref() === plan &&
            this.#publishedRetention.revision === this.#revision &&
            this.#publishedRetention.identity === retentionPlanIdentity(plan));
    }
    /**
     * Restart-safe, idempotent exact-key cleanup of the currently durable authority.
     * @internal
     */
    async resumeRetentionCleanup() {
        this.#assertMutable();
        if (!this.#store || !this.#gid)
            return;
        if (this.#dirty.size || this.#flushing)
            throw new Error("GroupHistoryTree: flush mutations before retention cleanup");
        this.#retentionActive = true;
        try {
            const persisted = await GroupHistoryTree.load(this.#store, this.#gid, {
                snapshotCacheSize: this.#cacheMax,
            });
            if (!persisted || !persisted.#checkpoint)
                return;
            const checkpoint = persisted.#checkpoint;
            if (this.#rootTag !== checkpoint.rootTag ||
                this.tags().join() !== checkpoint.members.join())
                throw new Error("GroupHistoryTree: cleanup authority differs from live membership");
            for (const [tag, snapshot] of Object.entries(checkpoint.projections))
                await this.#store.setItem(stateKey(this.#gid, tag), hexToBytes(snapshot));
            for (const tag of checkpoint.garbage) {
                await this.#store.removeItem(edgeKey(this.#gid, tag));
                await this.#store.removeItem(stateKey(this.#gid, tag));
                await this.#store.removeItem(commitKey(this.#gid, tag));
            }
            if (checkpoint.garbage.length ||
                Object.keys(checkpoint.projections).length) {
                const clean = { ...checkpoint, garbage: [], projections: {} };
                await this.#store.setItem(metaKey(this.#gid), encodeCheckpoint(clean));
                this.#checkpoint = clean;
            }
        }
        finally {
            this.#retentionActive = false;
        }
    }
    #adoptCheckpoint(checkpoint, snapshots) {
        const keep = new Set(checkpoint.members);
        for (const tag of this.tags())
            if (!keep.has(tag)) {
                this.#nodes.delete(tag);
                this.#heavy.delete(tag);
                this.#dirty.delete(tag);
            }
        for (const node of this.#nodes.values())
            node.childTags = node.childTags.filter((tag) => keep.has(tag));
        this.#nodes.get(checkpoint.rootTag).parentTag = undefined;
        this.#rootTag = checkpoint.rootTag;
        this.#checkpoint = checkpoint;
        this.#revision++;
        for (const [tag, snapshot] of snapshots)
            if (this.#heavy.has(tag))
                this.#putHeavy(tag, { snapshot, commit: this.#heavy.get(tag)?.commit });
    }
    async #validateCheckpoint(checkpoint) {
        const root = this.#nodes.get(checkpoint.rootTag);
        if (!root)
            throw new Error("GroupHistoryTree: logical root absent");
        if (checkpoint.boundary) {
            const b = checkpoint.boundary;
            if (root.parentTag !== b.parentTag ||
                root.epoch !== b.epoch + 1 ||
                !root.edge ||
                bytesToHex(root.edge.commitDigest) !== b.digest ||
                root.edge.senderLeafIndex !== b.senderLeafIndex ||
                this.#nodes.has(b.parentTag))
                throw new Error("GroupHistoryTree: invalid boundary provenance");
        }
        else if (root.parentTag || root.edge)
            throw new Error("GroupHistoryTree: unexpected root edge");
        for (const node of this.#nodes.values()) {
            if (!Number.isSafeInteger(node.epoch) || node.epoch < 0)
                throw new Error("GroupHistoryTree: invalid epoch");
            const seen = new Set();
            let cursor = node;
            while (cursor.tag !== root.tag) {
                if (seen.has(cursor.tag))
                    throw new Error("GroupHistoryTree: checkpoint cycle");
                seen.add(cursor.tag);
                const parent = cursor.parentTag
                    ? this.#nodes.get(cursor.parentTag)
                    : undefined;
                if (!parent || parent.epoch + 1 !== cursor.epoch)
                    throw new Error("GroupHistoryTree: retained parent closure broken");
                cursor = parent;
            }
            const primary = await this.#store.getItem(stateKey(this.#gid, node.tag));
            if (!primary)
                throw new Error("GroupHistoryTree: required snapshot missing");
            const snapshot = checkpoint.projections[node.tag] === undefined
                ? primary
                : hexToBytes(checkpoint.projections[node.tag]);
            const state = deserializeClientState(snapshot);
            if (bytesToHex(state.confirmationTag) !== node.tag ||
                Number(state.groupContext.epoch) !== node.epoch ||
                bytesToHex(state.groupContext.groupId) !== this.#gid)
                throw new Error("GroupHistoryTree: snapshot identity mismatch");
            const receivers = checkpoint.receivers[node.tag];
            const actual = [...state.historicalReceiverData.keys()]
                .map(Number)
                .sort((a, b) => a - b);
            if (actual.some((epoch) => !Number.isSafeInteger(epoch) || epoch < 0 || epoch >= node.epoch))
                throw new Error("GroupHistoryTree: invalid historical receiver epoch");
            if (receivers !== null &&
                actual.join() !== [...receivers].sort((a, b) => a - b).join())
                throw new Error("GroupHistoryTree: receiver allowlist mismatch");
            if (node.edge) {
                const record = await this.#store.getItem(commitKey(this.#gid, node.tag));
                if (!record || node.edge.commitDigest.length !== 32)
                    throw new Error("GroupHistoryTree: required commit missing");
                const wire = decodeOwnCommitRecord(record).wireBytes;
                if (bytesToHex(commitDigest(wire)) !==
                    bytesToHex(node.edge.commitDigest) ||
                    !decode(mlsMessageDecoder, wire))
                    throw new Error("GroupHistoryTree: invalid retained commit");
            }
        }
    }
    #assertMutable() {
        if (this.#retentionActive)
            throw new Error("GroupHistoryTree: retention publication or cleanup in progress");
    }
    #markDirty(tag) {
        this.#dirty.set(tag, ++this.#revision);
    }
    #encodePhysicalEdge(node) {
        const boundary = node.tag === this.#checkpoint?.rootTag
            ? this.#checkpoint.boundary
            : undefined;
        return encodeEdgeRecord(boundary ? { ...node, parentTag: boundary.parentTag } : node);
    }
    /** Inserts/refreshes a heavy entry at the LRU tail, then evicts if needed. */
    #putHeavy(tag, entry) {
        this.#heavy.delete(tag);
        this.#heavy.set(tag, entry);
        this.#evict();
    }
    /** Moves a heavy entry to the LRU tail (most-recently-used). */
    #touch(tag) {
        const entry = this.#heavy.get(tag);
        if (!entry)
            return;
        this.#heavy.delete(tag);
        this.#heavy.set(tag, entry);
    }
    /** Evicts clean (flushed) heavy entries oldest-first until within the cap. */
    #evict() {
        if (this.#heavy.size <= this.#cacheMax)
            return;
        for (const tag of this.#heavy.keys()) {
            if (this.#heavy.size <= this.#cacheMax)
                break;
            if (this.#dirty.has(tag))
                continue; // never evict unflushed material
            this.#heavy.delete(tag);
        }
    }
}
/** Encodes a node's light edge record (everything but the heavy material). */
function encodeEdgeRecord(node) {
    const w = new BinaryWriter().uint8(HISTORY_TREE_VERSION).varint(node.epoch);
    w.opaque(node.parentTag ? hexToBytes(node.parentTag) : new Uint8Array());
    if (node.parentTag) {
        w.opaque(node.edge?.commitDigest ?? new Uint8Array());
        if (node.edge?.senderLeafIndex !== undefined) {
            w.uint8(1).varint(node.edge.senderLeafIndex);
        }
        else {
            w.uint8(0);
        }
    }
    return w.build();
}
/** Decodes a light edge record into its node fields. */
function decodeEdgeRecord(bytes) {
    const r = new BinaryReader(bytes);
    const version = r.uint8();
    if (version !== HISTORY_TREE_VERSION)
        throw new Error(`GroupHistoryTree: unknown edge record version ${version}`);
    const epoch = r.varint();
    const parentBytes = r.opaque();
    const parentTag = parentBytes.length ? bytesToHex(parentBytes) : undefined;
    let edge;
    if (parentTag) {
        const commitDigestBytes = r.opaque();
        const senderPresent = r.uint8();
        const senderLeafIndex = senderPresent ? r.varint() : undefined;
        edge = { commitDigest: commitDigestBytes, senderLeafIndex };
    }
    r.end();
    return { epoch, parentTag, edge };
}
/** Encodes the meta record (the root tag pointer). */
function encodeMeta(rootTag) {
    return new BinaryWriter()
        .uint8(HISTORY_TREE_VERSION)
        .opaque(hexToBytes(rootTag))
        .build();
}
/** Decodes the meta record into the root tag. */
function decodeMeta(bytes) {
    const r = new BinaryReader(bytes);
    const version = r.uint8();
    if (version !== HISTORY_TREE_VERSION)
        throw new Error(`GroupHistoryTree: unknown meta version ${version}`);
    const rootBytes = r.opaque();
    r.end();
    return rootBytes.length ? bytesToHex(rootBytes) : undefined;
}
function encodeCheckpoint(checkpoint) {
    const payload = new TextEncoder().encode(JSON.stringify(checkpoint));
    const bytes = new Uint8Array(payload.length + 1);
    bytes[0] = 2;
    bytes.set(payload, 1);
    return bytes;
}
function decodeCheckpoint(bytes) {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(1)));
    if (!value || typeof value !== "object")
        throw new Error("GroupHistoryTree: invalid checkpoint");
    const c = value;
    const validTag = (tag) => typeof tag === "string" && /^(?:[0-9a-f]{2})+$/.test(tag);
    const tagsValid = (tags) => Array.isArray(tags) &&
        tags.every(validTag) &&
        new Set(tags).size === tags.length;
    if (c.version !== 2 ||
        !validTag(c.rootTag) ||
        !tagsValid(c.members) ||
        !tagsValid(c.garbage) ||
        !c.members.includes(c.rootTag) ||
        c.garbage.some((tag) => c.members.includes(tag)) ||
        !c.receivers ||
        typeof c.receivers !== "object" ||
        Array.isArray(c.receivers) ||
        Object.keys(c.receivers).length !== c.members.length ||
        !c.projections ||
        typeof c.projections !== "object" ||
        Array.isArray(c.projections) ||
        Object.entries(c.projections).some(([tag, snapshot]) => !c.members.includes(tag) || !validTag(snapshot)))
        throw new Error("GroupHistoryTree: invalid checkpoint membership");
    for (const tag of c.members) {
        const epochs = c.receivers[tag];
        if (epochs !== null &&
            (!Array.isArray(epochs) ||
                epochs.some((epoch) => !Number.isSafeInteger(epoch) || epoch < 0) ||
                new Set(epochs).size !== epochs.length))
            throw new Error("GroupHistoryTree: invalid receiver allowlist");
    }
    if (c.boundary &&
        (!validTag(c.boundary.parentTag) ||
            !Number.isSafeInteger(c.boundary.epoch) ||
            c.boundary.epoch < 0 ||
            !/^[0-9a-f]{64}$/.test(c.boundary.digest) ||
            (c.boundary.senderLeafIndex !== undefined &&
                (!Number.isSafeInteger(c.boundary.senderLeafIndex) ||
                    c.boundary.senderLeafIndex < 0))))
        throw new Error("GroupHistoryTree: invalid boundary provenance");
    return c;
}
