/** @module @category Core - Retained History */
/**
 * Classifies a late commit per `retained-history.md` "Late commits".
 *
 * Precedence: a commit below the anchor is always `beyond_anchor`; otherwise a
 * commit whose parent has not arrived is `deferred` (a transport gap, not
 * storage loss); within the rollback horizon it `replay`s when its retained
 * parent state is present and is `missing_retained_anchor` (→ `Unrecoverable`)
 * when that state was lost from storage; at/after the anchor but outside the
 * horizon it is `ineligible` for selection.
 */
export function classifyLateCommit(ctx) {
    if (ctx.sourceEpoch < ctx.anchorEpoch)
        return { kind: "beyond_anchor" };
    if (!ctx.parentArrived)
        return { kind: "deferred" };
    const withinHorizon = ctx.currentTipEpoch - ctx.sourceEpoch <= ctx.maxRewindCommits;
    if (!withinHorizon)
        return { kind: "ineligible" };
    return ctx.retainedParentStateAvailable
        ? { kind: "replay" }
        : { kind: "missing_retained_anchor" };
}
/**
 * Whether an MLS application message has fallen outside the retained app-payload
 * window and MUST expire: it is more than `appPayloadPastEpochLimit` past epochs
 * behind the current tip.
 */
export function isAppPayloadExpired(messageEpoch, currentTipEpoch, appPayloadPastEpochLimit) {
    return currentTipEpoch - messageEpoch > appPayloadPastEpochLimit;
}
/**
 * The minimum set of epochs a client must retain to replay candidate branches
 * inside the rollback horizon: every epoch from `tip - maxRewindCommits` (floored
 * at 0) through the current tip. Staged-commit and deferred-parent states are
 * additional and tracked separately by the caller.
 */
export function requiredRetainedEpochs(currentTipEpoch, maxRewindCommits) {
    const floor = Math.max(0, currentTipEpoch - maxRewindCommits);
    const epochs = [];
    for (let e = floor; e <= currentTipEpoch; e++)
        epochs.push(e);
    return epochs;
}
/**
 * The retained epochs a client SHOULD prune after convergence settles: those
 * older than the rollback horizon, excluding any `pinnedEpochs` still needed to
 * resolve an active PendingPublish / Merging / Recovering / Unrecoverable state.
 */
export function prunableRetainedEpochs(retainedEpochs, currentTipEpoch, maxRewindCommits, pinnedEpochs = []) {
    const floor = Math.max(0, currentTipEpoch - maxRewindCommits);
    const pinned = new Set(pinnedEpochs);
    const prunable = [];
    for (const epoch of retainedEpochs) {
        if (epoch < floor && !pinned.has(epoch))
            prunable.push(epoch);
    }
    return prunable.sort((a, b) => a - b);
}
//# sourceMappingURL=retained-history.js.map