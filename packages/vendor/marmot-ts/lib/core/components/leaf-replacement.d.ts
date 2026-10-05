/** @module @category Core - App Components */
import { type ProposalWithSender } from "../../vendor/ts-mls/index.js";
import type { ChangedLeaf } from "./tree-diff.js";
/**
 * The outcome of classifying a single {@link ChangedLeaf} against a commit's
 * proposal list and committer index (Phase 9, D-01): which of the three
 * legitimate sources produced this changed leaf, or that it could not be
 * attributed.
 */
export type ChangedLeafClassification = {
    kind: "add";
} | {
    kind: "update-proposal";
    senderLeafIndex: number;
} | {
    kind: "committer-update-path";
} | {
    kind: "unattributable";
} | {
    kind: "undecidable";
};
/**
 * The classification input {@link classifyChangedLeaf} needs: the commit's
 * full proposal list (bare or sender-attributed — normalized internally) and
 * its committer's MLS leaf index, when known.
 */
export interface ChangedLeafClassificationInput {
    proposals: readonly ProposalWithSender[];
    committerLeafIndex: number | undefined;
    /**
     * Whether `proposals` is this commit's COMPLETE proposal list. Defaults to
     * `true`; every seam that replays or builds a commit has the full list.
     *
     * Set to `false` only by callers that hold a partial list — currently just
     * `validateLegalityWithoutProposals` (`src/engine/fork-recovery.ts`), which
     * can recover the committer index off the wire but not the proposals. The
     * distinction is load-bearing (CR-01): "matches no proposal" only justifies
     * the terminal `unattributable` verdict when the proposals were actually in
     * hand. With an incomplete list, a legitimately added member's leaf matches
     * nothing merely because its Add is missing, so it must stay `undecidable`
     * rather than terminally reject an otherwise legal commit.
     */
    proposalsComplete?: boolean;
}
/**
 * Classifies a single {@link ChangedLeaf} into exactly one of five outcomes,
 * mirroring the three-bucket structure of MDK's
 * `validate_staged_commit_account_identity_proofs` (Add, Update proposals
 * keyed by sender, and the committer's own update-path leaf), plus the two
 * D-02/D-03 fallthrough outcomes.
 *
 * Evaluated in this exact order:
 * 1. If `input` is `undefined`, return `undecidable` immediately (D-03): the
 *    structural-impossibility signal for a caller holding no classification
 *    information whatsoever. This is NOT inferred from an empty `proposals`
 *    array — a legitimate proposal-less self-update commit has an empty list
 *    and a defined committer, and must stay decidable. A caller that knows
 *    the committer but not the proposals should instead supply them with
 *    {@link ChangedLeafClassificationInput.proposalsComplete} `false`, which
 *    keeps the committer's own leaf decidable (see step 5).
 * 2. Add bucket: matches only if the changed leaf's slot was genuinely freed
 *    AND any proposal normalizes to an Add whose
 *    `add.keyPackage.leafNode.signature` is byte-equal ({@link bytesEqual})
 *    to `changed.leaf.signature`. Matched by signature bytes, never by leaf
 *    index — a Remove+Add commit reuses a freed slot, so the index is
 *    worthless for identifying WHICH Add this is, and the signature is exact.
 *    The slot counts as freed when `changed.parentLeaf` is `undefined` (the
 *    parent tree held no leaf there) or this same commit carries a Remove of
 *    `changed.leafIndex`. That precondition is load-bearing (WR-04): this
 *    bucket performs no prior-identity comparison downstream — a new member in
 *    a freed slot legitimately has a different identity than whoever occupied
 *    the slot before removal — so without it, a persisted/corrupted resulting
 *    state that seats an Add's leaf over a STILL-OCCUPIED slot would skip the
 *    identity check altogether (fail-open). Such a leaf now falls through to
 *    `unattributable`/`undecidable` instead. Checked first, so an Add proposal
 *    is never shadowed by an incidental index match against
 *    `committerLeafIndex`.
 * 3. Update-proposal bucket: matches if any proposal is an Update with a
 *    defined `senderLeafIndex` numerically equal to `changed.leafIndex`.
 * 4. Committer bucket: matches if `input.committerLeafIndex` is defined and
 *    equal to `changed.leafIndex`.
 * 5. Nothing matched: `undecidable` (D-03) if `input.committerLeafIndex` is
 *    `undefined` — the leaf could still be the committer's own update-path
 *    leaf and there is no way to tell — or if `proposalsComplete` is `false`,
 *    since an Add that was never supplied could explain it (CR-01).
 *    Otherwise `unattributable` (D-02): full classification information WAS
 *    available and the leaf is attributable to nobody, so the caller must
 *    fail closed. The asymmetry is deliberate — `unattributable` is terminal,
 *    so it is only ever drawn from a complete picture.
 *
 * Total and non-throwing: every `ProposalWithSender` item is normalized
 * defensively (mirroring `validateAddProposalAccountIdentityProofs`), so a
 * caller passing bare `Proposal`-shaped items cannot crash the classifier.
 * Reads only `proposalType`, the narrowed payload, `senderLeafIndex`, and
 * signature bytes — no I/O, no throw.
 *
 * @see refs/mdk/crates/cgka-engine/src/account_identity_proof.rs `validate_staged_commit_account_identity_proofs`
 */
export declare function classifyChangedLeaf(changed: ChangedLeaf, input: ChangedLeafClassificationInput | undefined): ChangedLeafClassification;
