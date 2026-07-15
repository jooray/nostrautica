/** @module @category Engine */
import { type ClientState, type MlsMessage } from "ts-mls";
import { type ConvergencePolicy } from "../core/convergence.js";
/**
 * The bounded convergence window — the recent canonical states + applied commits
 * the convergence hot path needs to rebuild candidate branches and recover from
 * forks and late delivery (Marmot v2 `protocol-core/retained-history.md`).
 *
 * Holds, keyed by epoch number:
 *  - the canonical {@link ClientState} *at* each retained epoch (the parent for
 *    the next commit), and
 *  - the commit message applied to advance *from* each source epoch on our
 *    current canonical branch.
 *
 * Both maps are bounded to the rollback horizon (`max_rewind_commits`): material
 * older than `tip - maxRewindCommits` is pruned on every {@link record}. This is
 * a purely **in-memory, derived** index: it is never persisted (the full-fork
 * {@link GroupHistoryTree} is the single persisted source) and is rebuilt from
 * the tree's canonical path on load.
 */
export declare class RetainedHistoryStore {
    #private;
    constructor(init: ClientState, policy?: ConvergencePolicy);
    /** The retained canonical state at `epoch`, if still held. */
    stateAt(epoch: number): ClientState | undefined;
    /** Whether a canonical state is retained at `epoch`. */
    hasState(epoch: number): boolean;
    /** All retained canonical states (for cross-epoch decrypt retries). */
    states(): IterableIterator<ClientState>;
    /** Number of retained canonical states. */
    get size(): number;
    /** The oldest retained epoch (the retained anchor), or undefined if empty. */
    anchorEpoch(): number | undefined;
    /**
     * The commits applied on our current canonical branch from `forkEpoch`
     * (inclusive) up to but not including `tipEpoch`, in epoch order.
     */
    appliedCommitsBetween(forkEpoch: number, tipEpoch: number): MlsMessage[];
    /**
     * Records the retained parent state and the applied commit message after
     * advancing an epoch, then prunes retained material beyond the rollback
     * horizon (`retained-history.md`).
     *
     * `pinnedEpochs` are epochs the caller's active lifecycle still needs and that
     * MUST NOT be pruned even when older than the horizon (`retained-history.md`
     * "Pruning": state needed to resolve an active PendingPublish / Merging /
     * Recovering / Unrecoverable). The engine supplies them; e.g. the source epoch
     * of a staged local commit the canonical tip has since advanced past.
     */
    record(parentState: ClientState, appliedMessage: MlsMessage, newState: ClientState, pinnedEpochs?: Iterable<number>): void;
    /** The highest retained epoch (the canonical tip), or undefined if empty. */
    tipEpoch(): number | undefined;
}
