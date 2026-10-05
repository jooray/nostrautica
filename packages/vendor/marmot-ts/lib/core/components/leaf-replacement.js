/** @module @category Core - App Components */
import { defaultProposalTypes } from "../../vendor/ts-mls/index.js";
import { bytesEqual } from "./bytes.js";
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
export function classifyChangedLeaf(changed, input) {
    if (input === undefined)
        return { kind: "undecidable" };
    // WR-04: an Add may only claim a changed leaf whose slot was genuinely
    // vacated — either the parent tree held no leaf at that index at all, or
    // this same commit removes its prior occupant. Matching on signature bytes
    // alone let a STORED resulting state seat an Add over a still-occupied slot
    // and thereby skip the prior-occupant identity comparison entirely. That is
    // unreachable for a resulting state ts-mls computed (an Add is only ever
    // placed at a blank leaf), so no legitimate commit changes disposition here,
    // but it is reachable on the two paths that feed a PERSISTED resulting state
    // into this classifier — the known-state short-circuit and
    // `#treeResolution`'s stamped links — which is exactly the pre-upgrade
    // persisted edge this phase refuses to grandfather. An Add matching by
    // signature into a still-occupied, un-removed slot now falls through to
    // `unattributable`/`undecidable` instead: fail closed.
    const slotFreed = changed.parentLeaf === undefined ||
        input.proposals.some((item) => item.proposal.proposalType === defaultProposalTypes.remove &&
            "remove" in item.proposal &&
            Number(item.proposal.remove.removed) === changed.leafIndex);
    if (slotFreed) {
        for (const item of input.proposals) {
            const proposal = item.proposal;
            if (proposal.proposalType !== defaultProposalTypes.add)
                continue;
            if (!("add" in proposal))
                continue;
            if (bytesEqual(proposal.add.keyPackage.leafNode.signature, changed.leaf.signature)) {
                return { kind: "add" };
            }
        }
    }
    for (const item of input.proposals) {
        const proposal = item.proposal;
        if (proposal.proposalType !== defaultProposalTypes.update)
            continue;
        if (item.senderLeafIndex === undefined)
            continue;
        if (Number(item.senderLeafIndex) === changed.leafIndex) {
            return {
                kind: "update-proposal",
                senderLeafIndex: Number(item.senderLeafIndex),
            };
        }
    }
    if (input.committerLeafIndex !== undefined &&
        input.committerLeafIndex === changed.leafIndex) {
        return { kind: "committer-update-path" };
    }
    // Nothing matched. `unattributable` is a TERMINAL verdict, so it may only be
    // returned when this really is the whole picture: the committer is known AND
    // the proposal list is complete. An unknown committer leaves open that this
    // is the committer's own update-path leaf; an incomplete list leaves open
    // that an Add we never saw explains it (CR-01). In either case the honest
    // answer is `undecidable` — the caller is missing information, rather than
    // the leaf being attributable to nobody.
    return input.committerLeafIndex === undefined ||
        input.proposalsComplete === false
        ? { kind: "undecidable" }
        : { kind: "unattributable" };
}
