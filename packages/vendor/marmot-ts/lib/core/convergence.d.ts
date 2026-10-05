/**
 * Deterministic convergence primitives (Marmot v2 `protocol-core/convergence.md`).
 *
 * Convergence chooses one canonical branch from unordered group input using only
 * MLS-valid bytes, retained state, decrypted app payloads, and the group's
 * convergence policy — never transport arrival order, timestamps, outer event
 * ids, or local receive order. Every member processing the same epoch with the
 * same policy MUST select the same branch, so this logic is byte-for-byte
 * deterministic and ported directly from darkmatter `cgka-engine/src/convergence.rs`.
 *
 * This module is the pure selection/scoring core; candidate-branch construction
 * (replaying commits from retained states) and disposition assignment live in
 * the inbound/retained-history layers.
 */
/** The signed convergence policy governing branch selection for a group. */
export interface ConvergencePolicy {
    /**
     * The pinned convergence-policy profile this set of constants names
     * (`convergence.md`). Not a wire field — it identifies the profile; profile
     * `1` is the values in {@link DEFAULT_CONVERGENCE_POLICY}.
     */
    policyVersion: number;
    /** How far back from the current tip a branch MAY fork and stay eligible. */
    maxRewindCommits: number;
    /**
     * The width of the retained app-payload window: an MLS application message is
     * inside the window iff `reference_tip_epoch - message_epoch <= this`
     * (`retained-history.md` "App-payload retention"). Messages outside it expire
     * and MUST NOT count as convergence witnesses.
     */
    appPayloadPastEpochLimit: number;
    /**
     * The minimum quiescent time (ms) without new convergence-relevant input
     * before a convergence pass MAY be treated as settled and queued outbound work
     * released (`convergence.md`). Carried for completeness; the settle-window
     * state machine itself (B5) is not yet wired.
     */
    settlementQuiescenceMs: number;
    /** Maximum duration (ms) of one immutable convergence collection window. */
    maxConvergencePassMs: number;
    /** Distinct senders needed for one branch epoch to count toward witness quorum. */
    witnessQuorumSendersPerEpoch: number;
    /** Number of branch epochs that MUST meet sender quorum. */
    witnessQuorumEpochs: number;
    /** Maximum commit-depth boost a branch MAY receive from witness quorum. */
    maxWitnessOverrideDepth: number;
}
/**
 * The default Marmot convergence policy — profile version 1 (`convergence.md`).
 * Groups without explicit policy bytes MUST treat this as active.
 */
export declare const DEFAULT_CONVERGENCE_POLICY: ConvergencePolicy;
/** Input accepted from pre-bounded-pass callers that omit the v1 field. */
export type CompatibleConvergencePolicy = Omit<ConvergencePolicy, "maxConvergencePassMs"> & Partial<Pick<ConvergencePolicy, "maxConvergencePassMs">>;
/** Supplies the pinned v1 pass bound when decoding/configuring older policy input. */
export declare function normalizeConvergencePolicy(policy: CompatibleConvergencePolicy): ConvergencePolicy;
/**
 * Validates the witness-override invariant: a witness-quorum boost must never be
 * able to push a branch past the rollback horizon, so
 * `maxWitnessOverrideDepth <= maxRewindCommits`. Throws on violation.
 */
export declare function validateConvergencePolicy(policy: ConvergencePolicy): void;
/**
 * An app-payload witness: an MLS application message whose Marmot app payload
 * decrypts against a candidate branch state. `sender` is the account identity
 * authenticated by the MLS leaf credential (not a transport/leaf identity).
 */
export interface AppWitness {
    epoch: number;
    sender: Uint8Array;
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
export declare function isWitnessEligible(witness: AppWitness, forkEpoch: number, tipEpoch: number, policy: ConvergencePolicy): boolean;
/**
 * The authenticated ordering class of a branch's tip commit
 * (`convergence.md` "Candidate branches", `tip_priority`). A commit is
 * `privileged` exactly when its authorization rule requires an active admin;
 * the two commit shapes a non-admin may make (a self-update and a
 * SelfRemove-only commit) are `ordinary` whoever commits them.
 */
export type CommitOrderingPriority = "privileged" | "ordinary";
/**
 * Classifies a commit by the proposals it carries (inline and by reference),
 * mirroring MDK `commit_ordering_priority_for_staged`: a commit with no
 * proposals (a self-update; MLS forces an UpdatePath) or with only SelfRemove
 * proposals is `ordinary`; anything else needs an admin and is `privileged`.
 *
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs `is_allowed_non_admin_commit`
 */
export declare function commitOrderingPriority(proposals: readonly {
    proposal: {
        proposalType: number;
    };
}[]): CommitOrderingPriority;
/** A candidate branch produced by replaying commits from a retained state. */
export interface BranchCandidate {
    /** Caller-supplied identifier for the branch (not used in scoring). */
    id: string;
    /** The epoch where the branch diverged from retained canonical state. */
    forkEpoch: number;
    /** The epoch reached after replaying the branch's valid commits. */
    tipEpoch: number;
    /** SHA-256 (32 bytes) of the branch's tip commit MLS message bytes. */
    tipDigest: Uint8Array;
    /** Authenticated account identity of the tip commit's member sender. */
    tipCommitter?: Uint8Array;
    /**
     * Ordering class of the tip commit. Omitted is treated as `ordinary`, the
     * class that never outranks a known `privileged` tip.
     */
    tipPriority?: CommitOrderingPriority;
    /** App-payload witnesses that decrypt on candidate states in the branch. */
    appWitnesses: AppWitness[];
}
/** The derived comparison keys for a {@link BranchCandidate}. */
export interface BranchScore {
    validCommitDepth: number;
    effectiveCommitDepth: number;
    witnessQuorumMet: boolean;
    appWitnessScore: number;
    tipPriority: CommitOrderingPriority;
    tipDigest: Uint8Array;
    tipCommitter: Uint8Array;
}
/** Computes the {@link BranchScore} for a candidate under a policy. */
export declare function scoreBranch(branch: BranchCandidate, policy: ConvergencePolicy): BranchScore;
/**
 * Compares two branch scores per `convergence.md` "Branch selection": higher
 * effectiveCommitDepth, then witness quorum beats none, then higher
 * rawCommitDepth, then higher appWitnessScore, then a `privileged` tip before
 * an `ordinary` one, then LOWER tipCommitter, then LOWER tipDigest. Returns a
 * positive number when `a` ranks above `b` (so the canonical branch is the
 * maximum under this ordering).
 *
 * @see refs/mdk/crates/cgka-engine/src/convergence.rs `compare_scores`
 */
export declare function compareBranchScores(a: BranchScore, b: BranchScore): number;
/**
 * A branch is eligible only inside the rollback horizon:
 * `currentTipEpoch - forkEpoch <= maxRewindCommits` (`convergence.md`
 * "Eligibility").
 *
 * This predicate is intentionally horizon-only and takes no retained anchor.
 * `convergence.md` lists a second eligibility rule — "a branch that needs a
 * retained state older than the retained anchor MUST NOT be selected" — but that
 * guard is deliberately kept **separate** from this predicate, mirroring the
 * reference engine's two-layer structure (`is_branch_eligible` is horizon-only;
 * the anchor check lives in candidate admission + late-commit classification,
 * always anchor-first). Keeping the anchor out of here lets the predicate be
 * reused for horizon-only purposes (e.g. eligibility counts) and keeps it a pure
 * function of policy + branch, with no dependency on retained-store state. The
 * anchor guard is applied operationally: {@link classifyLateCommit} emits
 * `beyond_anchor` for a sub-anchor commit (ingest), and fork recovery cannot
 * build a branch whose `forkEpoch` state is no longer retained.
 */
export declare function isBranchEligible(currentTipEpoch: number, branch: BranchCandidate, policy: ConvergencePolicy): boolean;
/**
 * Selects the canonical branch from candidates: filters to eligible branches and
 * returns the maximum under {@link compareBranchScores}. On a full tie the later
 * candidate wins (matching Rust `max_by`). Returns undefined if none eligible.
 */
export declare function selectCanonicalBranch(currentTipEpoch: number, candidates: BranchCandidate[], policy: ConvergencePolicy): BranchCandidate | undefined;
/**
 * The content-derived ordering key for same-epoch races
 * (`convergence.md` "Same-epoch races"). `commitDigest` is `SHA-256` over the
 * commit's MLS message bytes; for equal `sourceEpoch`, the lower digest wins.
 */
export interface CommitOrderingKey {
    sourceEpoch: number;
    commitDigest: Uint8Array;
}
/** Computes the `commit_digest`: SHA-256 (32 bytes) of the commit MLS bytes. */
export declare function commitDigest(mlsBytes: Uint8Array): Uint8Array;
/**
 * Compares two commit ordering keys: lower sourceEpoch first, then lower
 * commitDigest. Negative when `a` orders before `b`. This is for branch choice
 * only; the stored message id used to mark a losing commit stays separate.
 */
export declare function compareCommitOrderingKeys(a: CommitOrderingKey, b: CommitOrderingKey): number;
