import { type CiphersuiteImpl, type ClientState, type IncomingMessageCallback, type MlsFramedMessage, MlsMessage, type ProcessMessageResult } from "../vendor/ts-mls/index.js";
import { type CommitIntegrityViolation } from "../core/components/integrity.js";
import { type AppWitness, type CommitOrderingPriority, type ConvergencePolicy, type BranchScore } from "../core/convergence.js";
import type { EdgeSnapshot } from "./history-tree.js";
import type { RetainedAppliedLink } from "./retained-store.js";
import type { DisbandCandidateEvidence, GroupPeeler } from "./types.js";
/** One applied step on a candidate branch: parent → message → child. */
export interface ChainLink {
    parent: ClientState;
    message: MlsMessage;
    child: ClientState;
}
/**
 * A resulting state already known for one of our own applied commits, together
 * with the confirmation tag of the exact parent it was applied to (CONV-04).
 *
 * The parent tag is load-bearing, not bookkeeping: `candidatesAt` admits any
 * pooled message whose framed epoch matches the DFS node's epoch and never
 * checks parentage, so without it the short-circuit would fire while exploring
 * a COMPETING fork node at the same epoch and splice our canonical chain onto
 * that branch — inflating its depth (the primary key `selectCanonicalBranch`
 * scores on) and, if it then won, corrupting `RetainedHistoryStore` with a
 * parent→child edge that never happened.
 */
export interface KnownNextState {
    parentTag: string;
    state: ClientState;
    /**
     * The commit's ordering class recorded when it was authored, used only when
     * its proposals cannot be rebuilt from the parent snapshot.
     */
    priority?: CommitOrderingPriority;
}
/** Shared parent-relative candidate resolution used by live and tree recovery. */
export type ParentResolution = {
    kind: "resolved";
    result: ProcessMessageResult & {
        kind: "newState";
    };
    /** Ordering class of the resolved commit (`convergence.md` `tip_priority`). */
    priority: CommitOrderingPriority;
} | {
    kind: "authentication_mismatch";
} | {
    kind: "rejected";
    reason: "authorization_or_components";
    /** The `processMessage` result the refusal was decided on. */
    result: ProcessMessageResult;
    violation?: CommitIntegrityViolation;
} | {
    kind: "deferred";
    reason: "temporary_refusal";
};
/**
 * A pooled candidate commit that authenticated against its parent but was
 * refused there (admin policy or commit legality) and never resolved on any
 * explored node (WR-01). Surfaced so the ingest seam can label it `rejected`
 * with the same reason as direct inbound ingest, instead of `past-epoch`.
 */
export interface RejectedForkCandidate {
    message: MlsMessage;
    result: ProcessMessageResult;
    violation?: CommitIntegrityViolation;
}
/**
 * Authenticates a Commit against one exact parent, then applies the shared
 * parent-relative authorization/component gate. A stamped own Commit is
 * already authenticated and authorized and therefore uses its recorded child
 * instead of being replayed. That child still passes the full
 * {@link validateCommitLegality} gate when the commit's proposals can be
 * rebuilt off the wire, and every proposal-independent legality check
 * ({@link validateLegalityWithoutProposals}) when they cannot (WR-03).
 */
export declare function resolveCandidateParent(params: {
    ciphersuite: CiphersuiteImpl;
    parent: ClientState;
    message: MlsFramedMessage;
    callback: IncomingMessageCallback;
    known?: KnownNextState;
}): Promise<ParentResolution>;
/** The outcome of resolving a fork; the caller applies state/lifecycle changes. */
export type ForkResolution = {
    outcome: "recovered";
    winnerTip: ClientState;
    winnerChain: ChainLink[];
    result: ProcessMessageResult;
    /** Every branch edge built while resolving (for history retention). */
    edges: EdgeSnapshot[];
    decision?: {
        selectedBranchId: string;
        selectedTipDigest: string;
        selectedTipCommitter: string;
        decisiveRule: string;
        score: BranchScore;
    };
    selectedTerminal?: DisbandCandidateEvidence;
    /** Pool candidates refused at their parent (WR-01). */
    rejected?: RejectedForkCandidate[];
} | {
    outcome: "superseded";
    edges: EdgeSnapshot[];
    winnerTip?: ClientState;
    decision?: {
        selectedBranchId: string;
        selectedTipDigest: string;
        selectedTipCommitter: string;
        decisiveRule: string;
        score: BranchScore;
    };
    selectedTerminal?: DisbandCandidateEvidence;
    /** Pool candidates refused at their parent (WR-01). */
    rejected?: RejectedForkCandidate[];
} | {
    outcome: "skip";
    rejected?: RejectedForkCandidate[];
};
/** Inputs needed to access retained history during fork resolution. */
export interface RetainedView {
    stateAt(epoch: number): ClientState | undefined;
    appliedCommitsBetween(forkEpoch: number, tipEpoch: number): MlsMessage[];
    appliedLinksBetween?(forkEpoch: number, tipEpoch: number): RetainedAppliedLink[];
}
/**
 * Convergence fork recovery (Marmot v2 `protocol-core/convergence.md`):
 * rebuilds candidate branches by replaying retained applied commits plus
 * competing commits, scores them with the pure {@link selectCanonicalBranch}
 * core, and reports the canonical branch so the caller can rewind.
 *
 * This is the stateful "candidate branch construction" layer that
 * `convergence.ts` deliberately leaves out. It holds no engine state of its own;
 * branch tip/chain bookkeeping is per-call. Mirrors darkmatter
 * `cgka-engine/src/fork_recovery.rs`.
 */
export declare class ForkRecovery<TEnvelope> {
    #private;
    constructor(ciphersuite: CiphersuiteImpl, peeler: GroupPeeler<TEnvelope>, policy?: ConvergencePolicy);
    /**
     * Resolves a fork at `forkEpoch` (`convergence.md`): rebuilds candidate
     * branches by replaying retained applied commits plus the competing `pool`,
     * selects the canonical branch, and reports it when it differs from the
     * caller's current tip. The caller applies the rewind (state + lifecycle).
     */
    resolveFork(params: {
        forkEpoch: number;
        pool: MlsMessage[];
        encrypted?: TEnvelope[];
        witnessEnvelopes?: TEnvelope[];
        currentState: ClientState;
        retained: RetainedView;
        /**
         * Builds the admin-verification callback for one explored parent state
         * (CR-02). Invoked per node, so every candidate commit is authorized
         * against its own parent rather than the caller's current tip.
         */
        adminCallbackFor: (parent: ClientState) => IncomingMessageCallback;
        terminalCandidates?: ReadonlyMap<string, DisbandCandidateEvidence>;
        knownCandidates?: ReadonlyMap<string, KnownNextState>;
    }): Promise<ForkResolution>;
}
/**
 * Collects the {@link AppWitness}es that decrypt against a single candidate
 * `state` (`convergence.md` "App-payload witnesses"): each witness envelope is
 * peeled and processed, and an authenticated application message contributes a
 * witness at `state`'s epoch keyed by the sender's account pubkey. Used by both
 * the pool-replay branch builder ({@link ForkRecovery}) and the tree-fed
 * re-convergence pass, which gathers witnesses per retained fork-branch node.
 */
export declare function collectWitnessesAt<TEnvelope>(params: {
    peeler: GroupPeeler<TEnvelope>;
    ciphersuite: CiphersuiteImpl;
    state: ClientState;
    witnessEnvelopes: TEnvelope[];
    callback: IncomingMessageCallback;
}): Promise<AppWitness[]>;
