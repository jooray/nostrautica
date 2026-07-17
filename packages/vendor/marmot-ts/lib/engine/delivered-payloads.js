/**
 * A bounded ledger of application payloads already delivered as `accepted`,
 * keyed by the branch state they decrypted on.
 *
 * Marmot v2 delivers app payloads eagerly — there is no settle-then-release
 * gate yet (that is B5) — so when a convergence fork rewind abandons a branch,
 * the payloads delivered on it MUST be retracted with an `invalidated`
 * notification. This ledger lets the engine find exactly those payloads on a
 * rewind.
 *
 * It holds no protocol state of its own; entries are pruned below the retained
 * anchor (a rewind can never reach there), so it stays bounded to the rollback
 * horizon. Mirrors the bookkeeping darkmatter does in
 * `distributed_convergence.rs` (`AppMessageInvalidated`).
 */
export class DeliveredPayloadLedger {
    #entries = [];
    /** Number of remembered payloads. */
    get size() {
        return this.#entries.length;
    }
    /** Remembers a delivered application payload. */
    record(entry) {
        this.#entries.push(entry);
    }
    /**
     * Removes and returns the payloads abandoned by a rewind to a canonical
     * branch: those delivered strictly after `forkEpoch` whose delivery state is
     * not on the canonical chain (`canonicalTags`). Payloads that decrypted on
     * the canonical branch, and any at or below the fork epoch (shared history),
     * are retained.
     */
    invalidatedByRewind(forkEpoch, canonicalTags) {
        const invalidated = [];
        const kept = [];
        for (const entry of this.#entries) {
            if (entry.epoch > forkEpoch && !canonicalTags.has(entry.stateTag)) {
                invalidated.push(entry);
            }
            else {
                kept.push(entry);
            }
        }
        this.#entries = kept;
        return invalidated;
    }
    /**
     * Drops entries below `epoch`. A rewind can never reach below the retained
     * anchor, so payloads older than it can never be invalidated and are dead
     * weight; pruning them keeps the ledger bounded to the rollback horizon.
     */
    pruneBelow(epoch) {
        this.#entries = this.#entries.filter((entry) => entry.epoch >= epoch);
    }
}
//# sourceMappingURL=delivered-payloads.js.map