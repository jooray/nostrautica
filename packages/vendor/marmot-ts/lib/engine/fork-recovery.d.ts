import { type CiphersuiteImpl, type ClientState, type IncomingMessageCallback, MlsMessage, type ProcessMessageResult } from "ts-mls";
import { type ConvergencePolicy } from "../core/convergence.js";
import type { EdgeSnapshot } from "./history-tree.js";
import type { GroupPeeler } from "./types.js";
/** One applied step on a candidate branch: parent → message → child. */
export interface ChainLink {
    parent: ClientState;
    message: MlsMessage;
    child: ClientState;
}
/** The outcome of resolving a fork; the caller applies state/lifecycle changes. */
export type ForkResolution = {
    outcome: "recovered";
    winnerTip: ClientState;
    winnerChain: ChainLink[];
    result: ProcessMessageResult;
    /** Every branch edge built while resolving (for history retention). */
    edges: EdgeSnapshot[];
} | {
    outcome: "superseded";
    edges: EdgeSnapshot[];
} | {
    outcome: "skip";
};
/** Inputs needed to access retained history during fork resolution. */
export interface RetainedView {
    stateAt(epoch: number): ClientState | undefined;
    appliedCommitsBetween(forkEpoch: number, tipEpoch: number): MlsMessage[];
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
        adminCallback: IncomingMessageCallback;
    }): Promise<ForkResolution>;
}
