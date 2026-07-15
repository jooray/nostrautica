import { EventSigner } from "applesauce-core";
import { type NostrEvent } from "applesauce-core/helpers";
import { EventEmitter } from "eventemitter3";
import { CiphersuiteImpl, ClientState, CryptoProvider, Welcome } from "ts-mls";
import { SerializedClientState } from "../core/client-state.js";
import type { MarmotGroupInfo } from "../core/client-state.js";
import { type AccountIdentityProofSigner } from "../core/account-identity-proof.js";
import type { ConvergencePolicy } from "../core/convergence.js";
import type { IngestionPoolOptions } from "../engine/ingestion-pool.js";
import type { AuditContextOptions, AuditSink } from "../audit/index.js";
import type { GenericKeyValueStore } from "../utils/key-value.js";
import { BaseGroupHistory, BaseGroupMedia, GroupHistoryFactory, GroupMediaFactory, MarmotGroup } from "./group/marmot-group.js";
import type { WelcomeKeyPackageCandidate } from "./key-package-store.js";
import { type CreateGroupOptions } from "./group-factory.js";
import type { GroupRuntime } from "./runtime/group-runtime.js";
import type { GroupPublishResult, GroupSessionSendIntent } from "./session/group-effects.js";
import type { DispositionedIngestResult, GroupSession } from "./session/group-session.js";
import type { NostrNetworkInterface, PublishResponse, Unsubscribable } from "./nostr-interface.js";
/** Options for {@link GroupsManager.connect} / {@link GroupsManager.connectAll}. */
export interface ConnectOptions {
    /**
     * Relays to subscribe on when a group carries no relays of its own. A group
     * with neither its own relays nor a fallback is skipped (it cannot receive,
     * just as it cannot send).
     */
    fallbackRelays?: string[];
}
/** Options for creating a new GroupsManager */
export type GroupsManagerOptions<THistory extends BaseGroupHistory | undefined = undefined, TMedia extends BaseGroupMedia | undefined = undefined> = {
    /** The backend storing serialized group state bytes */
    store: GenericKeyValueStore<SerializedClientState>;
    /**
     * Dedicated backend for the per-group rewind-history blob. When provided, the
     * convergence rewind window is persisted and survives a restart. Optional.
     */
    rewindStore?: GenericKeyValueStore<Uint8Array>;
    /** The signer used for the clients identity */
    signer: EventSigner;
    /**
     * Signs the account identity proof carried on the group creator's own leaf.
     * Required for the creator to be addable to spec-conformant groups, which
     * validate the proof on every leaf.
     */
    accountProofSigner?: AccountIdentityProofSigner;
    /** The nostr relay pool to use for the client */
    network: NostrNetworkInterface;
    /** Optional forensic audit sink inherited by groups. Omitted by default. */
    audit?: AuditSink;
    /** Required when `audit` is set; contains stable engine/account/session metadata. */
    auditContext?: AuditContextOptions;
    /** The crypto provider to use for cryptographic operations */
    cryptoProvider?: CryptoProvider;
    /** Optional group history factory passed to each MarmotGroup instance */
    historyFactory?: GroupHistoryFactory<THistory>;
    /** Optional group media factory passed to each MarmotGroup instance */
    mediaFactory?: GroupMediaFactory<TMedia>;
    /**
     * Convergence policy applied to every group (branch selection + the
     * `maxRewindCommits` rollback horizon). Set `maxRewindCommits: Infinity` to
     * keep forks of any age eligible for re-convergence. Defaults to profile 1.
     */
    convergencePolicy?: ConvergencePolicy;
    /**
     * Ingestion-pool tuning applied to every group: max entries and max epoch-age
     * for undecryptable events held for retry. Raise both for a debugging tool
     * that aims to retain and process everything.
     */
    ingestionPool?: IngestionPoolOptions;
};
/** Events emitted by {@link GroupsManager} */
export type GroupsManagerEvents<THistory extends BaseGroupHistory | undefined = any, TMedia extends BaseGroupMedia | undefined = any> = {
    /** Emitted when the set of loaded groups changes */
    updated: (groups: MarmotGroup<THistory, TMedia>[]) => void;
    /** Emitted when a group is loaded from the store */
    loaded: (group: MarmotGroup<THistory, TMedia>) => void;
    /** Emitted when a new group is created */
    created: (group: MarmotGroup<THistory, TMedia>) => void;
    /** Emitted when a group is imported from a ClientState object */
    imported: (group: MarmotGroup<THistory, TMedia>) => void;
    /** Emitted when a group is joined */
    joined: (group: MarmotGroup<THistory, TMedia>) => void;
    /** Emitted when a group is unloaded */
    unloaded: (groupId: Uint8Array) => void;
    /** Emitted when a group is destroyed */
    destroyed: (groupId: Uint8Array) => void;
    /** Emitted when the client leaves a group via self-remove proposal events */
    left: (groupId: Uint8Array) => void;
    /**
     * Emitted when an inbound commit removed the client from a group — an admin's
     * involuntary Remove, or a peer committing the client's own self_remove. The
     * group's local state is kept as a `removedFromGroup` tombstone; the app may
     * call {@link GroupsManager.destroy} to purge it.
     */
    removed: (groupId: Uint8Array) => void;
    /**
     * Emitted by a {@link GroupsManager.connect} subscription when a received
     * transport event could not be read (e.g. an epoch beyond the retained
     * rewind horizon). Lets the app surface dropped events instead of the
     * connection loop logging them.
     */
    unreadable: (groupId: Uint8Array, event: NostrEvent) => void;
};
/**
 * Orchestrates the lifecycle of {@link MarmotGroup} instances. Delegates
 * in-memory caching and store hydration to a {@link GroupRegistry} and group
 * construction to a {@link GroupFactory}, layering the public lifecycle events
 * (created/imported/joined/destroyed/left) and the send/ingest facade on top.
 */
export declare class GroupsManager<THistory extends BaseGroupHistory | undefined = any, TMedia extends BaseGroupMedia | undefined = any> extends EventEmitter<GroupsManagerEvents<THistory, TMedia>> {
    #private;
    /** The backend storing serialized group state bytes */
    readonly store: GenericKeyValueStore<SerializedClientState>;
    /** The signer used for the clients identity */
    readonly signer: EventSigner;
    /** Signs the account identity proof on the group creator's own leaf */
    readonly accountProofSigner?: AccountIdentityProofSigner;
    /** The nostr relay pool to use for the client */
    readonly network: NostrNetworkInterface;
    /** Crypto provider for cryptographic operations */
    cryptoProvider: CryptoProvider;
    constructor(options: GroupsManagerOptions<THistory, TMedia>);
    /** Returns the list of currently loaded group instances */
    get loaded(): MarmotGroup<THistory, TMedia>[];
    /** Lists all persisted group IDs, decoded from their hex storage keys. */
    listIds(): Promise<Uint8Array[]>;
    /** Checks if a group exists in the backend */
    has(groupId: Uint8Array | string): Promise<boolean>;
    /** Gets a group from cache or loads it from store */
    get(groupId: Uint8Array | string): Promise<MarmotGroup<THistory, TMedia>>;
    /** Returns the protocol session for a loaded or persisted group. */
    session(groupId: Uint8Array | string): Promise<GroupSession<THistory>>;
    /** Returns the runtime publisher for a loaded or persisted group. */
    runtime(groupId: Uint8Array | string): Promise<GroupRuntime>;
    /** Returns the complete group info/debug model for a loaded or persisted group. */
    info(groupId: Uint8Array | string): Promise<MarmotGroupInfo>;
    /**
     * Sends a session intent through the group, convergence-gated (B5): published
     * immediately when convergence is `Settled`, otherwise queued until the
     * quiescence window settles and the queue drains. Used by `commit`/`invite`
     * and direct application-message sends; `leave` bypasses the gate.
     */
    send(groupId: Uint8Array | string, intent: GroupSessionSendIntent): Promise<GroupPublishResult[]>;
    /**
     * Invites a user to a group from their KeyPackage event (kind 30443).
     *
     * Resolves the committing member from the manager's signer, builds an Add
     * commit intent via {@link createInviteIntent}, and drives it through the
     * group session/runtime. After the commit acks, the runtime delivers a
     * Welcome to the invitee via NIP-59 gift wrap.
     *
     * @returns Per-relay publish responses for the commit group event.
     * @throws Error if the event is not a KeyPackage kind or the credential
     *   identity does not match the event author.
     */
    invite(groupId: Uint8Array | string, keyPackageEvent: NostrEvent): Promise<Record<string, PublishResponse>>;
    /**
     * Creates a commit from proposals and publishes it to the group.
     *
     * Resolves the committing member from the manager's signer, builds a `commit`
     * intent, and drives it through the group session/runtime. See
     * {@link GroupSessionSendIntent} for how `extraProposals`, `proposalRefs`, and
     * `welcomeRecipients` are interpreted. Requires a group admin.
     *
     * @returns Per-relay publish responses for the commit group event.
     */
    commit(groupId: Uint8Array | string, options?: Omit<Extract<GroupSessionSendIntent, {
        kind: "commit";
    }>, "kind" | "actorPubkey">): Promise<Record<string, PublishResponse>>;
    /** Ingests group transport events through the group's protocol session. */
    ingest(groupId: Uint8Array | string, events: NostrEvent[], options?: {
        maxRetries?: number;
    }): AsyncGenerator<DispositionedIngestResult>;
    /** Loads all groups from the store and returns them */
    loadAll(): Promise<MarmotGroup<THistory, TMedia>[]>;
    /**
     * Connects a single group to its relays: backfills its kind-445 transport
     * events (by `#h` routing tag) and drains them through {@link MarmotGroup.ingest},
     * then opens a live subscription that ingests each subsequent event. Inbound
     * events are de-duplicated, and unreadable ones surface via the `unreadable`
     * event. Call `.unsubscribe()` on the result to disconnect.
     *
     * This is the inbound counterpart to the library's outbound publishing — the
     * relay-subscription/backfill/drain loop an app would otherwise hand-write.
     */
    connect(groupId: Uint8Array | string, options?: ConnectOptions): Promise<Unsubscribable>;
    /**
     * Connects every loaded group (see {@link connect}) and keeps the set of
     * connections in lockstep with the loaded groups: newly created/joined/
     * imported/loaded groups are connected automatically, and
     * destroyed/left/unloaded/removed groups are disconnected. Returns a handle
     * whose `.unsubscribe()` tears down every connection and stops tracking.
     */
    connectAll(options?: ConnectOptions): Unsubscribable;
    /**
     * Persists and caches a group built from a {@link ClientState}, emitting
     * the given lifecycle event. Used by higher-level flows (e.g. joining from
     * a welcome message) that construct ClientStates themselves.
     *
     * @param state - The ClientState to adopt
     * @returns The persisted and cached MarmotGroup
     * @throws Error if a group with the same id already exists
     */
    adoptClientState(state: ClientState, options?: {
        /** Which lifecycle event to emit. Defaults to `"imported"`. */
        emit?: "imported" | "joined";
    }): Promise<MarmotGroup<THistory, TMedia>>;
    /**
     * Imports a new group from a {@link ClientState} object, persisting it to
     * the store and emitting `imported`.
     */
    import(state: ClientState): Promise<MarmotGroup<THistory, TMedia>>;
    /**
     * Joins a group from a decoded MLS {@link Welcome} using locally held key
     * package candidates (produced by `KeyPackageManager.selectForWelcome`).
     *
     * Mirrors the darkmatter engine `do_join_welcome`: the KeyPackageRef→private
     * bundle match and the MLS join happen here, in the group layer, not in the
     * composition root. Tries candidates in priority order, validates every leaf
     * carries a valid account identity proof, then adopts the resulting state and
     * emits `joined`.
     *
     * @returns The joined group and the KeyPackageRef that was consumed (so the
     *   caller can mark it used), or `consumedKeyPackageRef: null` if none matched.
     */
    joinFromWelcome(options: {
        welcome: Welcome;
        candidates: WelcomeKeyPackageCandidate[];
        ciphersuiteImpl: CiphersuiteImpl;
    }): Promise<{
        group: MarmotGroup<THistory, TMedia>;
        consumedKeyPackageRef: Uint8Array | null;
    }>;
    /** Unloads a group from the client but does not remove it from the store */
    unload(groupId: Uint8Array | string): Promise<void>;
    /** Destroys a group and purges the group history */
    destroy(groupId: Uint8Array | string): Promise<void>;
    /**
     * Leaves a group by publishing a self-remove proposal and purging all
     * local group data from storage.
     *
     * At least one relay must acknowledge the proposals before local state is
     * destroyed. If no relay acks, an error is thrown and local state is
     * preserved so the caller can retry.
     *
     * @param groupId - The group ID as a hex string or Uint8Array.
     * @returns The relay publish responses for the leave proposal event(s).
     */
    leave(groupId: Uint8Array | string): Promise<Record<string, PublishResponse>>;
    /** Creates a new simple group */
    create(name: string, options?: CreateGroupOptions): Promise<MarmotGroup<THistory, TMedia>>;
    /**
     * Watches for changes to the groups in the store.
     * Returns an async generator that yields the current list of groups
     * whenever the store changes.
     */
    watch(): AsyncGenerator<MarmotGroup<THistory, TMedia>[]>;
}
