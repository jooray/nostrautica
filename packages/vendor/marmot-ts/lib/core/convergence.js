/** @module @category Core - Convergence */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { isAppPayloadExpired } from "./retained-history.js";
/**
 * The default Marmot convergence policy — profile version 1 (`convergence.md`).
 * Groups without explicit policy bytes MUST treat this as active.
 */
export const DEFAULT_CONVERGENCE_POLICY = {
    policyVersion: 1,
    maxRewindCommits: 5,
    appPayloadPastEpochLimit: 5,
    settlementQuiescenceMs: 1000,
    witnessQuorumSendersPerEpoch: 2,
    witnessQuorumEpochs: 1,
    maxWitnessOverrideDepth: 1,
};
/**
 * Validates the witness-override invariant: a witness-quorum boost must never be
 * able to push a branch past the rollback horizon, so
 * `maxWitnessOverrideDepth <= maxRewindCommits`. Throws on violation.
 */
export function validateConvergencePolicy(policy) {
    if (policy.maxWitnessOverrideDepth > policy.maxRewindCommits) {
        throw new Error(`Convergence policy invalid: max_witness_override_depth ` +
            `(${policy.maxWitnessOverrideDepth}) exceeds max_rewind_commits ` +
            `(${policy.maxRewindCommits})`);
    }
}
/**
 * Whether an app-payload witness counts toward a candidate branch's score
 * (`convergence.md` "App-payload witnesses", `retained-history.md`
 * "App-payload retention"). A witness MUST decrypt strictly after the branch's
 * `forkEpoch` (a message at/before the fork is not a witness for any candidate)
 * AND be inside the retained app-payload window evaluated with the candidate's
 * `tipEpoch` as the reference tip. Stale or pre-fork app payloads MUST NOT
 * influence branch selection.
 */
export function isWitnessEligible(witness, forkEpoch, tipEpoch, policy) {
    return (witness.epoch > forkEpoch &&
        !isAppPayloadExpired(witness.epoch, tipEpoch, policy.appPayloadPastEpochLimit));
}
function witnessesByEpoch(witnesses) {
    const byEpoch = new Map();
    for (const witness of witnesses) {
        let senders = byEpoch.get(witness.epoch);
        if (!senders) {
            senders = new Set();
            byEpoch.set(witness.epoch, senders);
        }
        senders.add(bytesToHex(witness.sender));
    }
    return byEpoch;
}
function witnessQuorumMet(witnesses, policy) {
    if (policy.witnessQuorumSendersPerEpoch === 0 ||
        policy.witnessQuorumEpochs === 0)
        return false;
    let qualifyingEpochs = 0;
    for (const senders of witnessesByEpoch(witnesses).values()) {
        if (senders.size >= policy.witnessQuorumSendersPerEpoch)
            qualifyingEpochs++;
    }
    return qualifyingEpochs >= policy.witnessQuorumEpochs;
}
function appWitnessScore(witnesses, policy) {
    let score = 0;
    for (const senders of witnessesByEpoch(witnesses).values()) {
        score += Math.min(senders.size, policy.witnessQuorumSendersPerEpoch);
    }
    return score;
}
function witnessDepthBoost(branch, policy) {
    return witnessQuorumMet(branch.appWitnesses, policy)
        ? policy.maxWitnessOverrideDepth
        : 0;
}
/** Computes the {@link BranchScore} for a candidate under a policy. */
export function scoreBranch(branch, policy) {
    const validCommitDepth = Math.max(0, branch.tipEpoch - branch.forkEpoch);
    return {
        validCommitDepth,
        effectiveCommitDepth: validCommitDepth + witnessDepthBoost(branch, policy),
        witnessQuorumMet: witnessQuorumMet(branch.appWitnesses, policy),
        appWitnessScore: appWitnessScore(branch.appWitnesses, policy),
        tipDigest: branch.tipDigest,
    };
}
/** Lexicographic comparison over raw bytes (a<b → -1, a>b → 1, equal → 0). */
function compareBytes(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i])
            return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
}
function cmpNum(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
/**
 * Compares two branch scores per `convergence.md` "Branch selection": higher
 * effectiveCommitDepth, then witness quorum beats none, then higher
 * rawCommitDepth, then higher appWitnessScore, then LOWER tipDigest. Returns a
 * positive number when `a` ranks above `b` (so the canonical branch is the
 * maximum under this ordering).
 */
export function compareBranchScores(a, b) {
    return (cmpNum(a.effectiveCommitDepth, b.effectiveCommitDepth) ||
        cmpNum(Number(a.witnessQuorumMet), Number(b.witnessQuorumMet)) ||
        cmpNum(a.validCommitDepth, b.validCommitDepth) ||
        cmpNum(a.appWitnessScore, b.appWitnessScore) ||
        // Lower tip digest wins, so invert the byte comparison.
        compareBytes(b.tipDigest, a.tipDigest));
}
/**
 * A branch is eligible only inside the rollback horizon:
 * `currentTipEpoch - forkEpoch <= maxRewindCommits`.
 */
export function isBranchEligible(currentTipEpoch, branch, policy) {
    return (Math.max(0, currentTipEpoch - branch.forkEpoch) <= policy.maxRewindCommits);
}
/**
 * Selects the canonical branch from candidates: filters to eligible branches and
 * returns the maximum under {@link compareBranchScores}. On a full tie the later
 * candidate wins (matching Rust `max_by`). Returns undefined if none eligible.
 */
export function selectCanonicalBranch(currentTipEpoch, candidates, policy) {
    let best;
    let bestScore;
    for (const candidate of candidates) {
        if (!isBranchEligible(currentTipEpoch, candidate, policy))
            continue;
        const score = scoreBranch(candidate, policy);
        if (bestScore === undefined || compareBranchScores(score, bestScore) >= 0) {
            best = candidate;
            bestScore = score;
        }
    }
    return best;
}
/** Computes the `commit_digest`: SHA-256 (32 bytes) of the commit MLS bytes. */
export function commitDigest(mlsBytes) {
    return sha256(mlsBytes);
}
/**
 * Compares two commit ordering keys: lower sourceEpoch first, then lower
 * commitDigest. Negative when `a` orders before `b`. This is for branch choice
 * only; the stored message id used to mark a losing commit stays separate.
 */
export function compareCommitOrderingKeys(a, b) {
    return (cmpNum(a.sourceEpoch, b.sourceEpoch) ||
        compareBytes(a.commitDigest, b.commitDigest));
}
//# sourceMappingURL=convergence.js.map