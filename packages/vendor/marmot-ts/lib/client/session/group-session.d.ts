/** @module @category Client - Session */
import type { NostrEvent } from "applesauce-core/helpers/event";
import { type CiphersuiteImpl, type ClientState, type Proposal } from "../../vendor/ts-mls/index.js";
import type { GroupProfileSupport } from "../../core/components/account-identity-proof.js";
import { type MarmotGroupView, type SerializedClientState } from "../../core/client-state.js";
import type { ConvergencePolicy } from "../../core/convergence.js";
import type { Disposition } from "../../core/inbound.js";
import type { AuditContextOptions, AuditSink } from "../../audit/index.js";
import type { IngestionPoolOptions } from "../../engine/ingestion-pool.js";
import { GroupHistoryTree } from "../../engine/history-tree.js";
import type { RetainedHistoryStore } from "../../engine/retained-store.js";
import type { DisbandRequest } from "../../engine/disband-request.js";
import { type DisbandTombstone } from "../../engine/disband-tombstone.js";
import type { IngestResult as EngineIngestResult, PendingState, ProposalContext, DisbandCandidateEvidence } from "../../engine/types.js";
import type { StateNotification } from "../../engine/state-notifications.js";
import type { GenericKeyValueStore } from "../../utils/key-value.js";
import type { GroupEffects, GroupSessionSendIntent } from "./group-effects.js";
/**
 * Public session results are the engine result union with the transport field
 * renamed at the Nostr boundary. Keeping this transformation distributive
 * makes new engine fields and variants flow through without a parallel union
 * that can silently drift (WR-12).
 */
type SessionIngestResult<TResult extends EngineIngestResult<NostrEvent>> = TResult extends {
    envelope: NostrEvent;
} ? Omit<TResult, "envelope"> & {
    event: NostrEvent;
} : TResult;
type EngineIngestResultOfKind<TKind extends EngineIngestResult<NostrEvent>["kind"]> = Extract<EngineIngestResult<NostrEvent>, {
    kind: TKind;
}>;
export type ProcessedIngestResult = SessionIngestResult<EngineIngestResultOfKind<"processed">>;
export type RejectedIngestResult = SessionIngestResult<EngineIngestResultOfKind<"rejected">>;
export type SkippedIngestResult = SessionIngestResult<EngineIngestResultOfKind<"skipped">>;
export type UnreadableIngestResult = SessionIngestResult<EngineIngestResultOfKind<"unreadable">>;
export type DeferredIngestResult = SessionIngestResult<EngineIngestResultOfKind<"deferred">>;
export type InvalidatedIngestResult = SessionIngestResult<EngineIngestResultOfKind<"invalidated">>;
export type AutoCommitIngestResult = SessionIngestResult<EngineIngestResultOfKind<"autoCommit">>;
export type RemovedIngestResult = SessionIngestResult<EngineIngestResultOfKind<"removed">>;
export type StateInvalidatedIngestResult = SessionIngestResult<EngineIngestResultOfKind<"stateInvalidated">>;
export type AppliedNotificationsIngestResult = SessionIngestResult<EngineIngestResultOfKind<"appliedNotifications">>;
export type StateRevalidatedIngestResult = SessionIngestResult<EngineIngestResultOfKind<"stateRevalidated">>;
export type IngestResult = SessionIngestResult<EngineIngestResult<NostrEvent>>;
export type DispositionedIngestResult = IngestResult & {
    disposition: Disposition;
};
export interface GroupSessionHistory {
    saveMessage(message: Uint8Array): Promise<void>;
    purgeMessages(): Promise<void>;
}
export type GroupSessionOptions<THistory extends GroupSessionHistory | undefined = undefined> = {
    state: ClientState;
    ciphersuite: CiphersuiteImpl;
    store: GenericKeyValueStore<SerializedClientState>;
    ingestStateStore?: GenericKeyValueStore<Uint8Array>;
    /** Durable lifecycle request/terminal store (defaults to ingestStateStore). */
    lifecycleStore?: GenericKeyValueStore<Uint8Array>;
    /**
     * Dedicated store for the full-fork history tree (per-node keys under a hex
     * group-id prefix). When set, the tree is flushed on {@link GroupSession.save}
     * and survives a restart. Optional — when omitted, history is in-memory only
     * and rebuilt from the current tip after each restart.
     */
    rewindStore?: GenericKeyValueStore<Uint8Array>;
    /** Group-scoped removal marker backend, potentially shared with state storage. */
    removedMarkerStore?: GenericKeyValueStore<boolean>;
    /**
     * The bounded convergence window, derived from the history tree on load (never
     * persisted separately). Set by the loader ({@link GroupRegistry}); fresh
     * groups seed it from the current tip.
     */
    retained?: RetainedHistoryStore;
    /**
     * A full-fork history tree rehydrated from {@link rewindStore} on load. When
     * omitted and a `rewindStore` is set, a fresh tree is bound to that store and
     * flushed on {@link GroupSession.save}.
     */
    historyTree?: GroupHistoryTree;
    /**
     * Convergence policy (branch selection + `maxRewindCommits` rollback horizon).
     * Defaults to the profile-1 policy; set `maxRewindCommits: Infinity` to retain
     * forks of any age for re-convergence.
     */
    convergencePolicy?: ConvergencePolicy;
    /**
     * Tuning for the persistent ingestion pool (undecryptable events held and
     * retried as the history tree grows): max entries and max epoch-age before an
     * unresolved entry is given up. Defaults bound it; a debugging tool that wants
     * to retain everything can raise both.
     */
    ingestionPool?: IngestionPoolOptions;
    history?: THistory;
    onStateChanged?: (state: ClientState) => void;
    onStateSaved?: () => void;
    onApplicationMessage?: (message: Uint8Array) => void;
    onHistoryError?: (error: Error) => void;
    onHistoryChanged?: () => void;
    /** Injectable wall-clock for the convergence quiescence window (B5; tests). */
    now?: () => number;
    /** Quiescence window (ms) before convergence may be treated as settled. */
    settlementQuiescenceMs?: number;
    /** Injectable settle-check timer (B5); defaults to `setTimeout`. */
    scheduler?: import("../../engine/group-engine.js").ConvergenceScheduler;
    /** Fired when the quiescence window elapses, so the owner can drain queued outbound (B5). */
    onSettleCheck?: () => void | Promise<void>;
    /** Optional forensic audit sink. Omitted by default; audit logging is app opt-in. */
    audit?: AuditSink;
    /** Required when `audit` is set; contains stable engine/account/session metadata. */
    auditContext?: AuditContextOptions;
};
export declare function ingestResultDisposition(result: IngestResult): Disposition;
export declare class GroupSession<THistory extends GroupSessionHistory | undefined = undefined> {
    #private;
    readonly ciphersuite: CiphersuiteImpl;
    readonly store: GenericKeyValueStore<SerializedClientState>;
    readonly rewindStore?: GenericKeyValueStore<Uint8Array>;
    readonly ingestStateStore?: GenericKeyValueStore<Uint8Array>;
    readonly lifecycleStore?: GenericKeyValueStore<Uint8Array>;
    readonly history: THistory;
    constructor(options: GroupSessionOptions<THistory>);
    get id(): Uint8Array;
    get state(): ClientState;
    set state(newState: ClientState);
    get lifecycle(): import("../../index.js").GroupLifecycleState;
    /**
     * Whether this group's canonical GroupContext still classifies as the
     * current account identity proof profile (D-11). Orthogonal to `lifecycle`:
     * an unsupported group can still be `Stable` — it stays listable and
     * `destroy()`-able, but every outbound `send` and every inbound envelope is
     * refused. Delegates to the engine, which recomputes this on every access.
     */
    get profileSupport(): GroupProfileSupport;
    /** The derived convergence status (`group-state.md` §Convergence status, B5). */
    get convergenceStatus(): import("../../core/convergence-status.js").ConvergenceStatus;
    get groupData(): MarmotGroupView | null;
    get relays(): string[] | undefined;
    /** The full-fork history tree (every observed state, canonical + forks). */
    get historyTree(): GroupHistoryTree;
    /**
     * The retained canonical states within the rollback horizon, newest epoch
     * first — the candidate epochs for cross-epoch encrypted-media decryption
     * (see {@link MarmotGroupEngine.retainedStates}).
     */
    retainedStates(): ClientState[];
    /**
     * Transport events received but not yet decrypted/processed into the history
     * tree — the engine's ingestion pool (undecryptable-so-far events held for
     * retry as the tree grows).
     */
    pendingEvents(): NostrEvent[];
    get unappliedProposals(): import("../../vendor/ts-mls/index.js").UnappliedProposals;
    get dirty(): boolean;
    save(force?: boolean): Promise<void>;
    /**
     * Re-scores the persisted fork history against the current tip and switches to
     * the canonical branch if a competing fork now wins (`convergence.md`), then
     * persists a resulting switch. Sources candidates from the history tree, so a
     * client that diverged onto a losing fork converges from disk without waiting
     * for the network to re-deliver the winning branch. Called on load.
     *
     * Returns the pass's results in the same shape {@link ingest} yields, so the
     * caller can route them through the identical handler — in particular the
     * `stateInvalidated` withdrawal that clears the removed-inactive marker
     * (CONV-03, D-12). This layer used to swallow them (CR-06).
     */
    reconverge(): Promise<DispositionedIngestResult[]>;
    /** Runs one retained-input scheduler edge through the normal reconciliation seam. */
    driveConvergence(): Promise<DispositionedIngestResult[]>;
    destroyLocalState(): Promise<void>;
    /** Returns authoritative terminal evidence, failing closed on corrupt bytes. */
    disbandTombstone(): Promise<DisbandTombstone | undefined>;
    /** Synchronous terminal authority after lifecycle hydration has completed. */
    get terminalTombstone(): DisbandTombstone | undefined;
    /** Durably records public notification delivery before application callbacks run. */
    markDisbandNotificationDelivered(): Promise<DisbandTombstone | undefined>;
    /** Waits until both durable lifecycle namespaces have been decoded. */
    hydrateLifecycleEvidence(): Promise<void>;
    /**
     * Commits selected terminal evidence before repeatable cleanup. The first
     * durable write is authoritative even if any later store operation fails.
     */
    persistSelectedDisband(evidence: DisbandCandidateEvidence): Promise<DisbandTombstone>;
    /** Releases engine resources (the settle-check timer); call on teardown (B5). */
    dispose(): void;
    confirmPublished(pending: PendingState): StateNotification[];
    publishFailed(pending: PendingState): void;
    proposalContext(): ProposalContext;
    send(intent: GroupSessionSendIntent): Promise<GroupEffects>;
    /** Persists irreversible terminal intent before returning publish work. */
    requestDisband(): Promise<GroupEffects>;
    /** Returns the hydrated durable disband request, if one exists. */
    disbandRequest(): Promise<DisbandRequest | undefined>;
    /** Builds the atomic active+required lifecycle enablement commit. */
    enableGroupDisbanding(): Promise<GroupEffects>;
    /**
     * Builds the self-remove proposal effects for leaving the group.
     *
     * Per RFC 9420 §12.4 a member cannot *commit* a Remove targeting their own
     * leaf, so this emits self-remove proposal(s) for the next committer (e.g.
     * an admin) to apply. Modelled as a send-intent — the darkmatter engine
     * exposes the same operation as `do_send_leave` rather than letting callers
     * hand-build the proposals.
     *
     * @param ownPubkey - The leaving member's Nostr public key (hex string).
     * @returns Publishable proposal effects (one per owned leaf node).
     */
    leave(ownPubkey: string): Promise<GroupEffects>;
    ingest(events: NostrEvent[], options?: {
        maxRetries?: number;
    }): AsyncGenerator<DispositionedIngestResult>;
    /** Establishes the durable application-observation boundary for an effect. */
    acknowledgeConvergenceEffect(result: Extract<DispositionedIngestResult, {
        kind: "stateInvalidated" | "stateRevalidated";
    }>): Promise<void>;
}
export type ProposalBuilder<Args extends unknown[], T extends Proposal | Proposal[]> = (...args: Args) => import("../../engine/types.js").ProposalAction<T>;
export {};
