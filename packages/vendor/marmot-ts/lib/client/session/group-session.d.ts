/** @module @category Client - Session */
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { CiphersuiteImpl, ClientState, Proposal } from "ts-mls";
import { type MarmotGroupView, type SerializedClientState } from "../../core/client-state.js";
import type { ConvergencePolicy } from "../../core/convergence.js";
import type { Disposition } from "../../core/inbound.js";
import type { AuditContextOptions, AuditSink } from "../../audit/index.js";
import type { IngestionPoolOptions } from "../../engine/ingestion-pool.js";
import { GroupHistoryTree } from "../../engine/history-tree.js";
import type { RetainedHistoryStore } from "../../engine/retained-store.js";
import type { PendingState, ProposalContext } from "../../engine/types.js";
import type { GenericKeyValueStore } from "../../utils/key-value.js";
import type { GroupEffects, GroupSessionSendIntent } from "./group-effects.js";
export type ProcessedIngestResult = {
    kind: "processed";
    result: import("ts-mls").ProcessMessageResult;
    event: NostrEvent;
    message: import("ts-mls").MlsMessage;
};
export type RejectedIngestResult = {
    kind: "rejected";
    result: import("ts-mls").ProcessMessageResult;
    event: NostrEvent;
    message: import("ts-mls").MlsMessage;
};
export type SkippedIngestResult = {
    kind: "skipped";
    event: NostrEvent;
    message: import("ts-mls").MlsMessage;
    reason: "past-epoch" | "wrong-wireformat" | "self-echo" | "beyond-anchor" | "missing-retained-anchor" | "invalid-app-payload";
};
export type UnreadableIngestResult = {
    kind: "unreadable";
    event: NostrEvent;
    errors: unknown[];
};
export type DeferredIngestResult = {
    kind: "deferred";
    event: NostrEvent;
    message: import("ts-mls").MlsMessage;
    reason: import("../../core/inbound.js").DeferredReason;
};
export type InvalidatedIngestResult = {
    kind: "invalidated";
    event: NostrEvent;
    message: import("ts-mls").MlsMessage;
    /** The decrypted Marmot app payload bytes of the invalidated message. */
    payload?: Uint8Array;
    /** Hex confirmation tag of the losing fork-tree node it decrypted against. */
    tag?: string;
    /** MLS epoch of that fork node. */
    epoch?: number;
};
export type AutoCommitIngestResult = {
    kind: "autoCommit";
    event: NostrEvent;
    pending: PendingState;
    actorPubkey: string;
};
export type RemovedIngestResult = {
    kind: "removed";
    result: import("ts-mls").ProcessMessageResult;
    event: NostrEvent;
    message: import("ts-mls").MlsMessage;
};
export type IngestResult = ProcessedIngestResult | RejectedIngestResult | SkippedIngestResult | DeferredIngestResult | InvalidatedIngestResult | AutoCommitIngestResult | RemovedIngestResult | UnreadableIngestResult;
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
    /**
     * Dedicated store for the full-fork history tree (per-node keys under a hex
     * group-id prefix). When set, the tree is flushed on {@link GroupSession.save}
     * and survives a restart. Optional — when omitted, history is in-memory only
     * and rebuilt from the current tip after each restart.
     */
    rewindStore?: GenericKeyValueStore<Uint8Array>;
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
    readonly history: THistory;
    constructor(options: GroupSessionOptions<THistory>);
    get id(): Uint8Array;
    get state(): ClientState;
    set state(newState: ClientState);
    get lifecycle(): import("../../index.js").GroupLifecycleState;
    /** The derived convergence status (`group-state.md` §Convergence status, B5). */
    get convergenceStatus(): import("../../core/convergence-status.js").ConvergenceStatus;
    get groupData(): MarmotGroupView | null;
    get relays(): string[] | undefined;
    /** The full-fork history tree (every observed state, canonical + forks). */
    get historyTree(): GroupHistoryTree;
    get unappliedProposals(): import("ts-mls").UnappliedProposals;
    get dirty(): boolean;
    save(force?: boolean): Promise<void>;
    destroyLocalState(): Promise<void>;
    /** Releases engine resources (the settle-check timer); call on teardown (B5). */
    dispose(): void;
    confirmPublished(pending: PendingState): void;
    publishFailed(pending: PendingState): void;
    proposalContext(): ProposalContext;
    send(intent: GroupSessionSendIntent): Promise<GroupEffects>;
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
}
export type ProposalBuilder<Args extends unknown[], T extends Proposal | Proposal[]> = (...args: Args) => import("../../engine/types.js").ProposalAction<T>;
