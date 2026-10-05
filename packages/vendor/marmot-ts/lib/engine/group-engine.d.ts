import { CiphersuiteImpl, ClientState } from "../vendor/ts-mls/index.js";
import { type CommitIntegrityViolation } from "../core/components/integrity.js";
import { type AccountIdentityProofRejectReason, type GroupProfileSupport } from "../core/components/account-identity-proof.js";
import { type ConvergenceStatus } from "../core/convergence-status.js";
import { type GroupLifecycleState } from "../core/group-lifecycle.js";
import { type AuditContextOptions, type AuditSink } from "../audit/index.js";
import type { GenericKeyValueStore } from "../utils/key-value.js";
import { GroupHistoryTree } from "./history-tree.js";
import { type IngestionPoolOptions } from "./ingestion-pool.js";
import { type StateNotification } from "./state-notifications.js";
import { RetainedHistoryStore } from "./retained-store.js";
import type { ConvergencePassState, DisbandCandidateEvidence, DispositionedIngestResult, GroupPeeler, PendingState, SendIntent, SendResult } from "./types.js";
import { type DisbandRequest } from "./disband-request.js";
/**
 * Thrown by {@link MarmotGroupEngine.send} (`case "commit"`) when a removal
 * commit's auto-coupled admin-policy update would leave the resulting epoch
 * with no surviving admin account (D-07). Thrown BEFORE `createCommit` — no
 * proposal is staged and the lifecycle stays `Stable`. The message names only
 * the count of admins that would be orphaned, never pubkeys
 * (diagnostics-privacy rule, `foundation/errors.md`).
 *
 * @see refs/mdk/crates/cgka-engine/src/message_processor/send.rs `do_send_remove_members` `AdminDepletion` guard
 */
export declare class AdminDepletionError extends Error {
    constructor(orphanedAdminCount: number);
}
/**
 * Thrown when a locally-staged commit violates a Marmot component-integrity
 * rule. The structured violation is retained so callers can branch on its
 * stable reason without matching the human-readable diagnostic message.
 */
export declare class CommitLegalityError extends Error {
    readonly violation: CommitIntegrityViolation;
    constructor(violation: CommitIntegrityViolation);
}
/**
 * Thrown before publishing a standalone proposal its sender is not authorized
 * to make (`app-components/admin-policy-v1.md`, `protocol-core/group-messaging.md`):
 * a non-admin's Add, Remove, Update, GroupContextExtensions or AppDataUpdate,
 * an admin's SelfRemove, or an unsupported proposal type. Every peer would
 * refuse it.
 */
export declare class ProposalAuthorizationError extends Error {
    readonly reason: string;
    constructor(reason: string);
}
/** Typed ordinary-outbound refusal while irreversible terminal intent is pending. */
export declare class DisbandingError extends Error {
    readonly reason: "disbanding";
    constructor();
}
/**
 * Thrown by {@link MarmotGroupEngine.send} for EVERY outbound intent kind
 * (application message, proposal, commit, self-update) when the group's
 * canonical GroupContext no longer classifies as the current account identity
 * proof profile (D-11): a legacy group, a mixed legacy/current group, or a
 * group with no `0x8009` requirement at all. Such a group loads and stays
 * listable/`destroy()`-able (D-11), but this client never validated its
 * members under the current profile, so all traffic is refused rather than
 * exchanged. The message is pubkey-free (diagnostics-privacy rule,
 * `foundation/errors.md`).
 *
 * @see refs/marmot/app-components/account-identity-proof-v2.md "Migration from v1"
 */
export declare class UnsupportedGroupProfileError extends Error {
    readonly proofReason: AccountIdentityProofRejectReason;
    readonly reason: "unsupported-profile";
    constructor(proofReason: AccountIdentityProofRejectReason);
}
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
    convergencePolicy?: import("../core/convergence.js").CompatibleConvergencePolicy;
    /**
     * Tuning for the persistent ingestion pool — undecryptable events held and
     * retried as the history tree grows, instead of being dropped. Defaults to a
     * size- and epoch-age-bounded pool.
     */
    ingestionPool?: IngestionPoolOptions;
    /**
     * Injectable monotonic clock (ms) for bounded convergence passes. Defaults
     * to `performance.now()`; tests pass a fake clock for determinism.
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
    /** Durable lifecycle records shared with terminal settlement. */
    lifecycleStore?: GenericKeyValueStore<Uint8Array>;
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
     * The undecryptable events currently held in the ingestion pool, oldest-first:
     * received transport envelopes that have not yet decrypted/processed into the
     * history tree (e.g. a newer-epoch message awaiting its commit, or a fork
     * message awaiting its branch). They are retried as the tree grows; an entry
     * that never clears is a received event the unlocking state never arrived for.
     */
    pendingEnvelopes(): TEnvelope[];
    /**
     * The full-fork history tree: every group state observed — the canonical
     * branch and every fork — keyed by MLS confirmation tag. Read-only structural
     * access; the engine grows it as commits and proposals arrive.
     */
    get history(): GroupHistoryTree;
    /**
     * The retained canonical states within the rollback horizon, newest epoch
     * first. Used for cross-epoch encrypted-media decryption: media is keyed by
     * its source-epoch exporter secret, which is not carried on the wire, so a
     * receiver tries each still-retained epoch's key. States older than
     * `max_rewind_commits` are pruned (`retained-history.md`); media from a pruned
     * epoch can no longer be decrypted.
     */
    retainedStates(): ClientState[];
    get state(): ClientState;
    set state(newState: ClientState);
    /**
     * Whether the group's canonical GroupContext still classifies as the
     * current account identity proof profile (D-11). A derived read, computed
     * fresh from `this.#state` on every access — never cached — so it always
     * reflects the latest adopted state. Never throws.
     */
    get profileSupport(): GroupProfileSupport;
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
    /** Snapshot of the active immutable pass, exposed for scheduler diagnostics. */
    get convergencePass(): ConvergencePassState | undefined;
    /** Canonical terminal evidence retained until the client persists its tombstone. */
    get selectedDisbandEvidence(): DisbandCandidateEvidence | undefined;
    /** Number of envelopes retained but not yet admitted to a convergence pass. */
    get retainedConvergenceInputCount(): number;
    /** Opens or refreshes the current collection pass from the monotonic clock. */
    admitConvergencePass(): ConvergencePassState;
    /** Current durable irreversible request, hydrated before this promise resolves. */
    disbandRequest(): Promise<DisbandRequest | undefined>;
    /** Flushes restart-critical terminal candidate/pass evidence. */
    persistDisbandConvergence(): Promise<void>;
    /** Persist irreversible intent, then prepare its exact candidate against this epoch. */
    requestDisband(): Promise<SendResult<TEnvelope> | undefined>;
    /** Atomically enables lifecycle-v1 for a legacy group when every leaf supports it. */
    enableGroupDisbanding(): Promise<SendResult<TEnvelope> | undefined>;
    /** Executes a local send intent and returns the wrapped transport envelope. */
    send(intent: SendIntent): Promise<SendResult<TEnvelope>>;
    /**
     * Applies staged state after publish confirmation (publish-before-apply).
     *
     * CR-09: `selfUpdate` takes the identical path to `commit` — it is a commit
     * in every sense that matters here (it advances the epoch and produces a new
     * confirmation tag), so it must be recorded into retained history and the
     * fork tree. Recording it only via `#setState` left `RetainedHistoryStore`
     * with no `stateAt(newEpoch)` (so `resolveFork` could never rebuild across a
     * selfUpdate) and the tree with no node for the new tip (so the next
     * `GroupRegistry.#loadHistory` discarded the entire persisted fork history).
     * Since `refs/marmot/protocol-core/joining.md` tells clients to selfUpdate
     * immediately after joining from a Welcome, the normal join path destroyed
     * its own convergence persistence.
     */
    confirmPublished(pending: PendingState): StateNotification[];
    /**
     * Reverts lifecycle when a staged commit publish fails or is abandoned.
     * Covers both commit-producing seams (CR-09/WR-17): a selfUpdate now also
     * transitions to `PendingPublish`, so a failed publish must roll it back or
     * the engine would be stuck unable to prepare any further commit.
     */
    publishFailed(pending: PendingState): void;
    /**
     * Ingests transport envelopes and applies MLS messages to group state.
     *
     * WR-04 — terminal facts after an envelope-free rewind: most results name
     * their triggering envelope, but a rewind driven entirely by pool replay or
     * by the persisted history tree has none. Such a rewind reports itself as
     * `appliedNotifications` results, which now carry `selectedTerminal` and
     * `removedFromGroup` so a consumer building its own transport can see a
     * disband selection or its own removal without reaching into engine state.
     *
     * A rewind that produced NO notifications yields no result at all, so those
     * two facts have nothing to ride on. Consumers that must not miss them —
     * rather than merely observe them — should re-read
     * {@link selectedDisbandEvidence} and `state.groupActiveState` after fully
     * draining this generator. The client layer (`MarmotGroup`,
     * `GroupSession`) already does exactly that.
     *
     * @yields DispositionedIngestResult - processing result plus inbound
     *   {@link Disposition}.
     */
    ingest(envelopes: TEnvelope[], options?: {
        maxRetries?: number;
    }): AsyncGenerator<DispositionedIngestResult<TEnvelope>>;
    /**
     * Admits retained input into a later pass once lifecycle and the prior fixed
     * deadline permit it. Each call is a deterministic one-shot scheduler edge.
     */
    driveConvergence(): Promise<DispositionedIngestResult<TEnvelope>[]>;
    /**
     * Releases engine resources — currently the pending settle-check timer.
     * Called on group teardown (destroy/unload) so no timer outlives the group.
     */
    dispose(): void;
    /**
     * Drives one tree-fed re-convergence pass to completion, switching to the
     * canonical branch if the persisted history now favors a competing fork. Public
     * entry for the load path (after the engine hydrates from the tree) and any
     * caller wanting an explicit re-evaluation. Witness-free — the structural keys
     * decide; witnesses refine on the next live ingest/sweep.
     *
     * Returns every result the pass produced, dispositioned and audited exactly
     * as {@link ingest} does, so a caller can route them through the identical
     * handler.
     *
     * CR-06: these results MUST reach the caller. `#reconvergeFromTree` is the
     * only site that can yield the `stateInvalidated` withdrawal proving a
     * rewind superseded the commit that removed us, and that withdrawal is what
     * clears the persisted removed-inactive marker (CONV-03, D-12). While this
     * method drained into `void _`, a client that was removed on a losing fork,
     * restarted, and re-converged onto a branch where it is still a member ended
     * up with canonical membership restored AND a stale marker still set —
     * silently suppressing the next genuine removal.
     */
    reconvergeFromHistory(): Promise<DispositionedIngestResult<TEnvelope>[]>;
}
