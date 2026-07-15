import { type ClientState, type MlsMessage } from "ts-mls";
import type { GenericKeyValueStore } from "../utils/key-value.js";
/** The store backing a tree's heavy material. A `GenericKeyValueStore<Uint8Array>`. */
type HistoryTreeStore = GenericKeyValueStore<Uint8Array>;
/**
 * Protocol-level metadata for one edge — the commit that produced a node from
 * its parent. The decrypted commit bytes themselves are retained separately
 * (see {@link GroupHistoryTree.commitBytesOf}) so the tree is self-contained and
 * replayable without the transport's event store.
 */
export interface HistoryEdge {
    /** SHA-256 (32 bytes) of the commit MLS message bytes — the edge identity. */
    commitDigest: Uint8Array;
    /** The committer's MLS leaf index, when the caller knows it. */
    senderLeafIndex?: number;
}
/**
 * An edge plus its child's pre-serialized snapshot, captured at the moment the
 * child state is produced (see {@link GroupHistoryTree.recordEdge}). Fork
 * recovery emits these so loser branches are retained with pristine snapshots.
 */
export interface EdgeSnapshot {
    /** Parent node tag (must already be in the tree). */
    parentTag: string;
    /** Child node tag (hex of the child state's confirmation tag). */
    childTag: string;
    /** The child state's MLS epoch. */
    childEpoch: number;
    /** Serialized commit `MlsMessage` that produced the child. */
    commitBytes: Uint8Array;
    /** SHA-256 of `commitBytes`. */
    commitDigest: Uint8Array;
    /** Serialized child `ClientState`, captured before any secret zeroing. */
    childSnapshot: Uint8Array;
    /** The committer's MLS leaf index, when known. */
    senderLeafIndex?: number;
}
/**
 * A node in the group history tree: one MLS group state. The node id is the hex
 * of the state's MLS `confirmationTag`, which is unique per state (it is a MAC
 * over the confirmed transcript hash, so two same-epoch forks have distinct
 * tags). Every non-root node has exactly one parent — the state its commit was
 * applied to — so the structure is a tree rooted at the welcome/creation state;
 * more than one child marks a fork.
 */
export interface HistoryNode {
    /** Node id: hex of the MLS confirmation tag. */
    tag: string;
    /** The MLS epoch this state sits at. */
    epoch: number;
    /** Parent node tag, or `undefined` for the root. */
    parentTag?: string;
    /** Child node tags. More than one means a fork was observed at this node. */
    childTags: string[];
    /** The commit edge from the parent. `undefined` only for the root. */
    edge?: HistoryEdge;
}
/**
 * The retained group history tree (Marmot v2 full-fork history). Holds every
 * group state ever observed — the canonical branch and every fork — as a tree
 * of {@link ClientState} snapshots linked by commit edges. No pruning is
 * performed: the tree retains everything.
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
export declare class GroupHistoryTree {
    #private;
    /** Seeds an empty tree, optionally with a root {@link ClientState}. */
    constructor(root?: ClientState, options?: {
        snapshotCacheSize?: number;
    });
    /** The root node tag (the welcome/creation state), or `undefined` if empty. */
    get rootTag(): string | undefined;
    /** Number of nodes (states) retained in the tree. */
    get size(): number;
    /** Whether unflushed changes are pending. */
    get isDirty(): boolean;
    /**
     * Sets the root from a {@link ClientState}. The root carries no commit edge.
     * Throws if a different root is already set (a tree has exactly one root).
     */
    setRoot(state: ClientState): string;
    /** Whether a node with `tag` exists. */
    hasNode(tag: string): boolean;
    /** Returns a read-only view of a node, or `undefined` if absent. */
    node(tag: string): HistoryNode | undefined;
    /** All node tags, in insertion order. */
    tags(): string[];
    /** The epoch of a node, or `undefined` if absent. */
    epochOf(tag: string): number | undefined;
    /** The parent tag of a node, or `undefined` for the root / absent node. */
    parentOf(tag: string): string | undefined;
    /** Child tags of a node (empty for a tip or an absent node). */
    childrenOf(tag: string): string[];
    /** Whether a node is a tip (exists and has no children). */
    isTip(tag: string): boolean;
    /** All tip tags (leaf states) — the candidate branches for convergence. */
    tips(): string[];
    /** All node tags sitting at `epoch`. */
    nodesAtEpoch(epoch: number): string[];
    /**
     * The path from the root to `tag` (inclusive of both), or `undefined` if the
     * node is absent or its chain to the root is broken.
     */
    path(tag: string): string[] | undefined;
    /** Ancestor tags of a node, nearest-first (excludes the node itself). */
    ancestors(tag: string): string[];
    /**
     * The lowest common ancestor of two nodes (the fork point), or `undefined` if
     * they share no ancestor (e.g. live in different trees).
     */
    lowestCommonAncestor(a: string, b: string): string | undefined;
    /**
     * The serialized `ClientState` snapshot bytes for a node, or `undefined` if
     * absent. Served from the in-memory cache, else fetched from the store.
     */
    snapshotOf(tag: string): Promise<Uint8Array | undefined>;
    /**
     * Rehydrates a node's state into a fresh, independent {@link ClientState}, or
     * `undefined` if no snapshot is retained. Each call decodes a new object, so
     * callers may mutate/advance it without affecting the tree.
     */
    stateAt(tag: string): Promise<ClientState | undefined>;
    /** The serialized commit bytes that produced a node, or `undefined`. */
    commitBytesOf(childTag: string): Promise<Uint8Array | undefined>;
    /** Decodes the commit `MlsMessage` that produced a node, or `undefined`. */
    commitMessageOf(childTag: string): Promise<MlsMessage | undefined>;
    /**
     * Records a commit applied from a retained parent node to its resulting child
     * state, adding (or linking) the child node. Idempotent on the child tag: a
     * duplicate commit re-links without overwriting. Throws if the parent is not
     * already in the tree.
     *
     * @returns the child node tag.
     */
    recordCommit(parentTag: string, commitMessage: MlsMessage, childState: ClientState, senderLeafIndex?: number): string;
    /**
     * Records an edge from a snapshot captured at branch-build time. Unlike
     * {@link recordCommit}, the child snapshot is supplied pre-serialized — fork
     * recovery serializes each branch state the instant it is produced, before
     * ts-mls can zero that state's secrets when exploring its children. Idempotent
     * on the child tag. Returns `false` (without recording) when the parent is not
     * yet in the tree, so a batch can skip a dangling edge instead of throwing.
     */
    recordEdge(edge: EdgeSnapshot): boolean;
    /**
     * Replaces a node's retained snapshot — used after staging a proposal onto a
     * node, which updates its `unappliedProposals` without advancing the epoch.
     * The new state's confirmation tag MUST equal the node tag (staging a proposal
     * does not change it). Throws if the node is absent or the tag would change.
     */
    updateSnapshot(tag: string, state: ClientState): void;
    /**
     * Binds a backing store to a fresh, in-memory tree so its nodes can be flushed
     * and its heavy material later evicted/reloaded. Marks every current node
     * dirty so the first {@link flush} persists the whole tree. A no-op if the
     * same store is already bound (e.g. on a tree loaded via {@link load}).
     */
    bindStore(store: HistoryTreeStore): void;
    /**
     * Persists all unflushed nodes incrementally: each dirty node's light edge
     * record, snapshot, and commit bytes are written under its own keys, plus the
     * meta (root) record. Append-only — already-persisted nodes are untouched, so
     * a save costs O(new nodes), not O(tree). Requires a bound store.
     */
    flush(): Promise<void>;
    /**
     * Loads a tree's light index from a store (heavy material stays lazy). Returns
     * `undefined` if no tree is persisted under `gid`. The store stays bound, so
     * snapshots/commit bytes are fetched on demand.
     */
    static load(store: HistoryTreeStore, gid: string, options?: {
        snapshotCacheSize?: number;
    }): Promise<GroupHistoryTree | undefined>;
    /** Removes every persisted key for a group's tree from the store. */
    static purge(store: HistoryTreeStore, gid: string): Promise<void>;
}
export {};
