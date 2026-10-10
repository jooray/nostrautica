import { DEFAULT_CONVERGENCE_POLICY, } from "../core/convergence.js";
import { prunableRetainedEpochs } from "../core/retained-history.js";
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
export class RetainedHistoryStore {
    /** Canonical state at each retained epoch. Holds the state *at* that epoch. */
    #states = new Map();
    /** Commit applied to advance *from* each source epoch on our branch. */
    #appliedLinks = new Map();
    #policy;
    constructor(init, policy = DEFAULT_CONVERGENCE_POLICY) {
        this.#policy = policy;
        this.#states.set(Number(init.groupContext.epoch), init);
    }
    /** The retained canonical state at `epoch`, if still held. */
    stateAt(epoch) {
        return this.#states.get(epoch);
    }
    /** Whether a canonical state is retained at `epoch`. */
    hasState(epoch) {
        return this.#states.has(epoch);
    }
    /** All retained canonical states (for cross-epoch decrypt retries). */
    states() {
        return this.#states.values();
    }
    /** Number of retained canonical states. */
    get size() {
        return this.#states.size;
    }
    /** The oldest retained epoch (the retained anchor), or undefined if empty. */
    anchorEpoch() {
        let min;
        for (const epoch of this.#states.keys())
            if (min === undefined || epoch < min)
                min = epoch;
        return min;
    }
    /**
     * The commits applied on our current canonical branch from `forkEpoch`
     * (inclusive) up to but not including `tipEpoch`, in epoch order.
     */
    appliedCommitsBetween(forkEpoch, tipEpoch) {
        return this.appliedLinksBetween(forkEpoch, tipEpoch).map((link) => link.message);
    }
    /**
     * Parent-bound applied links on the current canonical branch. Unlike a
     * digest plus later epoch lookups, each entry keeps the exact parent state
     * (including proposal-reference evidence) beside its resulting state.
     */
    appliedLinksBetween(forkEpoch, tipEpoch) {
        const out = [];
        for (let e = forkEpoch; e < tipEpoch; e++) {
            const link = this.#appliedLinks.get(e);
            if (link)
                out.push(link);
        }
        return out;
    }
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
    record(parentState, appliedMessage, newState, pinnedEpochs = [], ownCommitStamp) {
        const parentEpoch = Number(parentState.groupContext.epoch);
        const newEpoch = Number(newState.groupContext.epoch);
        const preceding = this.#appliedLinks.get(parentEpoch - 1);
        if (preceding)
            preceding.resultingState = parentState;
        this.#states.set(parentEpoch, parentState);
        this.#states.set(newEpoch, newState);
        this.#appliedLinks.set(parentEpoch, {
            parentState,
            message: appliedMessage,
            resultingState: newState,
            ownCommitStamp,
        });
        const max = this.#policy.maxRewindCommits;
        const pins = new Set(pinnedEpochs);
        for (const epoch of prunableRetainedEpochs(this.#states.keys(), newEpoch, max, pins))
            this.#states.delete(epoch);
        for (const epoch of prunableRetainedEpochs(this.#appliedLinks.keys(), newEpoch, max, pins))
            this.#appliedLinks.delete(epoch);
    }
    /** The highest retained epoch (the canonical tip), or undefined if empty. */
    tipEpoch() {
        let max;
        for (const epoch of this.#states.keys())
            if (max === undefined || epoch > max)
                max = epoch;
        return max;
    }
}
