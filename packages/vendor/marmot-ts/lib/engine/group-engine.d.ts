import { CiphersuiteImpl, ClientState } from "ts-mls";
import { type ConvergenceStatus } from "../core/convergence-status.js";
import { type ConvergencePolicy } from "../core/convergence.js";
import { type GroupLifecycleState } from "../core/group-lifecycle.js";
import { type AuditContextOptions, type AuditSink } from "../audit/index.js";
import { GroupHistoryTree } from "./history-tree.js";
import { type IngestionPoolOptions } from "./ingestion-pool.js";
import { RetainedHistoryStore } from "./retained-store.js";
import type { DispositionedIngestResult, GroupPeeler, PendingState, SendIntent, SendResult } from "./types.js";
/** An opaque handle returned by {@link ConvergenceScheduler.setTimer}. */
export type TimerHandle = unknown;
/**
 * Injectable timer used to fire the convergence settle-check once the quiescence
 * window elapses (B5). Defaults to `setTimeout`/`clearTimeout`; tests pass a
 * controllable fake so the settle moment is deterministic.
 */
export interface ConvergenceScheduler {
    setTimer(ms: number, cb: () => void): TimerHandle;
    clearTimer(handle: TimerHandle): void;
}
export type MarmotGroupEngineOptions<TEnvelope> = {
    state: ClientState;
    ciphersuite: CiphersuiteImpl;
    peeler: GroupPeeler<TEnvelope>;
    onStateChanged?: (state: ClientState) => void;
    /**
     * The bounded convergence window (canonical states + applied commits within
     * the rollback horizon), derived from the history tree on load. When omitted
     * it is seeded with only the current tip (no past-epoch rewind until new
     * commits accrue). Never persisted separately — the tree is the source.
     */
    retained?: RetainedHistoryStore;
    /**
     * A pre-populated full-fork history tree, rehydrated from persistence. When
     * omitted the tree is seeded with the current tip as its root and grows as
     * commits arrive.
     */
    historyTree?: GroupHistoryTree;
    /**
     * The signed convergence policy governing branch selection and the rollback
     * horizon (`maxRewindCommits`). Defaults to {@link DEFAULT_CONVERGENCE_POLICY}.
     * Set `maxRewindCommits` to `Infinity` to never expire old forks (the full
     * history tree retains everything regardless). Validated on construction.
     */
    convergencePolicy?: ConvergencePolicy;
    /**
     * Tuning for the persistent ingestion pool — undecryptable events held and
     * retried as the history tree grows, instead of being dropped. Defaults to a
     * size- and epoch-age-bounded pool.
     */
    ingestionPool?: IngestionPoolOptions;
    /**
     * Injectable wall-clock (ms) for the convergence-status quiescence window
     * (B5). Defaults to `Date.now`; tests pass a fake clock for determinism.
     */
    now?: () => number;
    /**
     * Quiescence window (ms) before a convergence pass may be treated as settled
     * (`convergence.md` `settlementQuiescenceMs`). Defaults to the profile-1 value.
     */
    settlementQuiescenceMs?: number;
    /** Injectable timer for the settle-check; defaults to `setTimeout` (B5). */
    scheduler?: ConvergenceScheduler;
    /**
     * Called once the quiescence window elapses after convergence-relevant input,
     * so the owner can re-check {@link convergenceStatus} and release any queued
     * outbound work (B5). The engine itself holds no outbound queue.
     */
    onSettleCheck?: () => void | Promise<void>;
    /** Optional forensic audit sink. Omitted by default; audit logging is app opt-in. */
    audit?: AuditSink;
    /** Required when `audit` is set; contains stable engine/account/session metadata. */
    auditContext?: AuditContextOptions;
};
/**
 * Transport-agnostic MLS group state machine: ingest, send intents, fork
 * recovery, and publish-before-apply lifecycle for local commits.
 *
 * This class is a coordinator. The heavy concerns live in focused modules it
 * composes: retained history ({@link RetainedHistoryStore}), convergence fork
 * recovery ({@link ForkRecovery}), and the inbound pipeline ({@link
 * ingestEnvelopes}). The engine owns only the live state and lifecycle, the
 * send path, and the wiring between those modules — mirroring darkmatter's
 * `cgka-engine` split across `message_processor/{ingest,send,store}`,
 * `fork_recovery`, and `epoch_manager`.
 */
export declare class MarmotGroupEngine<TEnvelope> {
    #private;
    readonly ciphersuite: CiphersuiteImpl;
    readonly peeler: GroupPeeler<TEnvelope>;
    constructor(options: MarmotGroupEngineOptions<TEnvelope>);
    /** Number of undecryptable events currently held in the ingestion pool. */
    get pendingCount(): number;
    /**
     * The full-fork history tree: every group state observed — the canonical
     * branch and every fork — keyed by MLS confirmation tag. Read-only structural
     * access; the engine grows it as commits and proposals arrive.
     */
    get history(): GroupHistoryTree;
    get state(): ClientState;
    set state(newState: ClientState);
    /**
     * The group's lifecycle state (`group-state.md`). A new local commit may only
     * be prepared while `Stable`; the commit flow moves through `PendingPublish`
     * (commit prepared, publish unconfirmed) and `Merging` (publish acked, staged
     * commit applying) and back to `Stable`.
     */
    get lifecycle(): GroupLifecycleState;
    /**
     * The derived convergence status (`group-state.md` §Convergence status, B5):
     * `Syncing` while the quiescence window since the last convergence-relevant
     * input has not elapsed, then `Resolving` / `Blocked` / `Settled` per the last
     * pass. Recomputed on every read against the injected clock, so it advances to
     * `Settled` as wall-clock time passes even with no new input.
     */
    get convergenceStatus(): ConvergenceStatus;
    /** Executes a local send intent and returns the wrapped transport envelope. */
    send(intent: SendIntent): Promise<SendResult<TEnvelope>>;
    /** Applies staged state after publish confirmation (publish-before-apply). */
    confirmPublished(pending: PendingState): void;
    /** Reverts lifecycle when a staged commit publish fails or is abandoned. */
    publishFailed(pending: PendingState): void;
    /**
     * Ingests transport envelopes and applies MLS messages to group state.
     *
     * @yields DispositionedIngestResult - processing result plus inbound
     *   {@link Disposition}.
     */
    ingest(envelopes: TEnvelope[], options?: {
        maxRetries?: number;
    }): AsyncGenerator<DispositionedIngestResult<TEnvelope>>;
    /**
     * Releases engine resources — currently the pending settle-check timer.
     * Called on group teardown (destroy/unload) so no timer outlives the group.
     */
    dispose(): void;
}
