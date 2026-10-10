/** @module @category Core - App Components */
import { ClientState, GroupContextExtension, Proposal, ProposalWithSender } from "../../vendor/ts-mls/index.js";
import { AppComponentId } from "./ids.js";
import { type AccountIdentityProofRejectReason } from "./account-identity-proof.js";
import { type ChangedLeafClassificationInput } from "./leaf-replacement.js";
/**
 * Ported commit-legality validators for the Marmot app-component layer.
 *
 * Both validators here are pure, seam-agnostic, and non-throwing by design
 * (D-01/D-02 split): they read plain `GroupContextExtension[]` values and
 * return a typed {@link CommitIntegrityViolation} instead of throwing, so
 * every calling seam (send, inbound, convergence/replay) decides its own
 * disposition — throw, `rejected`, or drop-edge — for the same violation.
 *
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs
 * @see Marmot v2 spec: app-components/README.md, app-components/admin-policy-v1.md
 */
/** The reason a commit was found to violate a ported MDK commit-legality rule. */
export type CommitIntegrityViolationReason = "component-integrity" | "admin-leaf-coupling" | "disband-legality" | "account-identity-proof";
/**
 * A typed, non-throwing violation returned by {@link validateAppComponentIntegrity},
 * {@link validateAdminLeafCoupling}, or {@link validateCommitLegality}.
 *
 * `detail` is a diagnostic string naming component ids and counts only — never
 * raw pubkeys or other protocol-sensitive material (diagnostics-privacy rule,
 * see foundation/errors.md). The protocol-visible signal is `reason`.
 *
 * `proofReason` and `leafIndex` are populated only for `reason:
 * "account-identity-proof"` violations (D-06), by
 * {@link validateCommitAccountIdentityProofs} and
 * {@link validateAddProposalAccountIdentityProofs}. Both are pubkey-free:
 * `proofReason` is the caught {@link AccountIdentityProofError.reason} literal
 * and `leafIndex` is the failing leaf's true MLS tree leaf index (`./tree-diff.js`
 * `diffChangedLeaves`'s `leafIndex` — never the member-enumeration index
 * `validateGroupMemberAccountIdentityProofs` uses internally). `leafIndex` is
 * omitted for a profile-drift violation (no single leaf is at fault) and for a
 * pre-apply Add-proposal violation (the leaf has no tree position yet).
 */
export interface CommitIntegrityViolation {
    reason: CommitIntegrityViolationReason;
    detail: string;
    proofReason?: AccountIdentityProofRejectReason;
    leafIndex?: number;
}
/**
 * The tri-state result of {@link validateCommitAccountIdentityProofs} and
 * {@link validateCommitLegality} (Phase 9, D-03): a commit's legality against a
 * candidate parent is not always a yes/no answer.
 *
 * - `legal` — every check passed; the commit may be applied.
 * - `violation` — a definite, terminal rejection. The calling seam decides its
 *   own disposition for this (throw, `rejected`, or drop the candidate edge)
 *   — this type stays seam-agnostic.
 * - `undecidable` — authorization could not be evaluated against this
 *   candidate parent (most commonly: a changed leaf could not be attributed
 *   to any Add, Update proposal, or the committer, because the caller had no
 *   proposal list or committer index to classify it with). Per
 *   `refs/marmot/foundation/errors.md` (lines 63-68), a Commit whose
 *   authorization cannot be evaluated against a candidate parent MUST map to
 *   the seam's own deferral idiom — never to a terminal rejection. `detail`
 *   is a pubkey-free diagnostic string (D-06).
 *
 * A definite `violation` always outranks `undecidable`: every producer of
 * this union checks every changed leaf before reporting `undecidable`, so a
 * commit that is provably illegal is rejected rather than pooled, even when
 * it also carries an unattributable leaf.
 */
export type CommitLegalityOutcome = {
    kind: "legal";
} | {
    kind: "violation";
    violation: CommitIntegrityViolation;
} | {
    kind: "undecidable";
    detail: string;
};
/**
 * A single `AppDataUpdate` operation extracted from a commit's proposals, in
 * the shape {@link validateAppComponentIntegrity} consumes. `data === undefined`
 * means the operation is a Remove (mirrors MDK's `Option<&[u8]>` with `None` =
 * Remove).
 */
export interface AppDataUpdateOp {
    componentId: AppComponentId;
    data: Uint8Array | undefined;
}
/**
 * Turns a commit's `Proposal[]` into the `AppDataUpdateOp[]` shape every seam
 * feeds to {@link validateAppComponentIntegrity} (and, later, the shared seam
 * adapter). This is the single adapter every seam uses so the proposal → op
 * mapping is never re-implemented seam-locally.
 *
 * Preserves commit order and does not deduplicate. Note that a legal commit
 * never carries more than one `AppDataUpdate` op for the same component id —
 * `validatePreApplyProposals` (`src/engine/admin-policy.ts`) rejects a
 * duplicate id before apply, matching MDK's `seen` set in
 * `validate_app_data_update_batch_against`. This adapter stays
 * duplicate-tolerant anyway because it is a pure mapping run on the
 * already-admitted batch, and because rule 3 of
 * {@link validateAppComponentIntegrity} must stay well-defined even for a
 * batch that reached it without pre-apply admission.
 */
export declare function collectAppDataUpdateOps(proposals: readonly Proposal[]): AppDataUpdateOp[];
/**
 * Ported from `validate_app_component_integrity_for_staged_commit`: rejects a
 * commit whose resulting GroupContext strips or rewrites Marmot component
 * state outside the validated `AppDataUpdate` channel.
 *
 * Enforced rules, in order (mirrors the MDK rustdoc numbering):
 * 1. the `app_data_dictionary` extension itself may never be dropped if it was
 *    present before;
 * 2. the `app_components` id (`0x0001`) and every id in the CURRENT epoch's
 *    required-component-id list may never be dropped;
 * 3. every dictionary entry that changes relative to the current epoch —
 *    added, rewritten, or removed — must match one of this commit's own
 *    `AppDataUpdate` operations.
 *
 * @param args.requiredIds MUST be derived by the caller from the CURRENT
 * (pre-commit) extensions — see Pitfall 2 in 03-RESEARCH.md. Deriving this
 * from `resultingExtensions` would let a commit add an id to `app_components`
 * and thereby protect that same id in the same commit, which is the exact bug
 * class this validator exists to close.
 *
 * Additionally, per account-identity-proof-v2.md "Lifecycle, authorization, and
 * removal" ("It is not GroupContext state and MUST NOT be created, replaced, or
 * removed with `AppDataUpdate`"), this rejects any commit whose `AppDataUpdate`
 * ops target the leaf-only account identity proof component (`0x8009`), or
 * whose resulting GroupContext dictionary carries a `0x8009` entry at all —
 * mirroring MDK's `CURRENT_PROFILE_LEAF_ONLY_APP_COMPONENTS`.
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs `validate_app_component_integrity_for_staged_commit`
 * @see Marmot v2 spec: app-components/README.md "Update Processing", "Unknown Data"
 */
export declare function validateAppComponentIntegrity(args: {
    currentExtensions: GroupContextExtension[];
    resultingExtensions: GroupContextExtension[];
    appDataUpdateOps: readonly AppDataUpdateOp[];
    requiredIds: readonly AppComponentId[];
}): CommitIntegrityViolation | undefined;
/**
 * Ported from `validate_admin_leaf_coupling_for_staged_commit`: enforces the
 * admin-policy resulting-epoch invariant (admin-policy-v1.md "Validation") —
 * every admin key in the resulting epoch's admin set MUST correspond to an
 * account with at least one member leaf in the resulting epoch.
 *
 * `resultingMemberAccounts` is the set of hex account pubkeys that have at
 * least one member leaf in the RESULTING epoch (D-08: account-level, not
 * leaf-level — an account with two leaves survives if only one is removed).
 * Callers derive it from the post-apply state; this validator stays pure and
 * MLS-free.
 *
 * When the resulting extensions carry no admin-policy bytes, this evaluates
 * the carried-forward (current-epoch) admin set instead of skipping the check
 * (Pitfall 3): a membership-only commit that de-leafs an admin without
 * touching admin-policy bytes must still be rejected.
 *
 * An empty resolved admin set returns `undefined` (vacuously satisfied):
 * component bytes cannot encode an empty admin list, so an empty resolved set
 * means the epoch carries no admin-policy state at all — not a bypass, per
 * MDK's own documented rationale for the same early return.
 *
 * Does NOT special-case SelfRemove (Pitfall 4): a non-admin's SelfRemove never
 * changes the admin set and passes trivially here; an admin's SelfRemove is
 * already refused earlier by `createAdminCommitPolicyCallback`
 * (`src/engine/admin-policy.ts`), so this validator never needs its own
 * carve-out for it.
 *
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs `validate_admin_leaf_coupling_for_staged_commit`, `reject_admins_without_member_accounts`
 * @see Marmot v2 spec: app-components/admin-policy-v1.md "Validation"
 */
export declare function validateAdminLeafCoupling(args: {
    currentExtensions: GroupContextExtension[];
    resultingExtensions: GroupContextExtension[];
    resultingMemberAccounts: readonly string[];
}): CommitIntegrityViolation | undefined;
/**
 * Ported from `validate_staged_commit_account_identity_proofs` (D-01, D-02,
 * D-03), extended in Phase 9 (UPD-01) with replacement-leaf identity binding.
 * Rejects a commit that drifts the GroupContext account-identity-proof
 * profile away from `"current"`, that carries an invalid `0x8009` proof on
 * any new or re-signed member leaf, or that replaces an existing member's
 * leaf with one bound to a different account identity. Pure and non-throwing
 * — returns a {@link CommitLegalityOutcome} rather than throwing or returning
 * `undefined`.
 *
 * Three checks, in order:
 * (a) **Profile drift (D-01a).** Both `parentState` and `resultingState` must
 *     classify as the current profile ({@link getGroupProfileSupport}). Both
 *     are checked — not just the resulting one — so a commit can never
 *     "fix" an already-drifted parent into passing; the profile must already
 *     have been, and remain, current.
 * (b) **Changed-leaf proof validity (D-01b, D-02, D-03).** Every entry
 *     {@link diffChangedLeaves} reports between the two ratchet trees — every
 *     non-blank leaf that is new (Add) or re-signed (Update proposal, or the
 *     committer's own update-path leaf) — is validated with
 *     {@link validateLeafAccountIdentityProof} against the RESULTING epoch's
 *     ciphersuite. Unchanged leaves are trusted and never re-validated (D-01).
 *     This runs BEFORE bucket classification for every changed leaf, so
 *     UPD-02/UPD-03 keep reporting their existing proof reasons regardless of
 *     which bucket the leaf falls into.
 * (c) **Replacement-leaf identity binding (UPD-01, D-01/D-02/D-03).** Each
 *     changed leaf is classified with {@link classifyChangedLeaf} against
 *     `args.classification` (when supplied):
 *       - `add` — a new member in a freed slot legitimately carries a
 *         different identity than whoever occupied the slot before removal;
 *         no prior-identity comparison runs (D-01).
 *       - `update-proposal` / `committer-update-path` — a genuine replacement
 *         of an existing member's leaf. Its {@link ChangedLeaf.parentLeaf} MUST
 *         be defined (a replacement always has a prior occupant); if it is
 *         not, or if `getCredentialPubkey` throws for either leaf, this is a
 *         fail-closed violation. Otherwise the replacement leaf's account
 *         identity is compared against the prior leaf's; a mismatch is a
 *         terminal `member-identity-changed` violation (UPD-01) — per
 *         account-identity-proof-v2.md, a change of account identity is not a
 *         self-update.
 *       - `unattributable` — the changed leaf matches no Add, no Update
 *         sender, and is not the committer's own leaf, with full
 *         classification information available: fail closed as
 *         `unattributable-leaf` (D-02).
 *       - `undecidable` — classification information was incomplete (no
 *         `args.classification`, or an undefined `committerLeafIndex` with no
 *         matching proposal). This does NOT return immediately: the loop
 *         continues, because a definite violation elsewhere in the commit
 *         must always outrank an undecidable leaf (D-03) — otherwise a
 *         provably illegal commit could be pooled and retried until it ages
 *         out instead of being rejected. The first undecidable leaf's detail
 *         is remembered and returned only if the whole loop completes with no
 *         violation.
 *
 * Every thrown `AccountIdentityProofError` (or any other unexpected throw) is
 * caught and mapped to a typed violation, never left to escape — fork-recovery
 * and tree-fed convergence call {@link validateCommitLegality} unwrapped.
 * Every `detail` string this function builds names only the numeric
 * `leafIndex` and a reason literal — never credential bytes, account
 * identity, pubkey hex, or `err.message` (D-06, diagnostics-privacy rule).
 *
 * @see refs/mdk/crates/cgka-engine/src/account_identity_proof.rs `validate_staged_commit_account_identity_proofs`, `validate_leaf_account_identity_proof_for_member`
 * @see refs/marmot/app-components/account-identity-proof-v2.md "Validation"
 * @see refs/marmot/foundation/errors.md lines 63-68 (deferred vs terminal authorization_failed)
 */
export declare function validateCommitAccountIdentityProofs(args: {
    parentState: ClientState;
    resultingState: ClientState;
    classification?: ChangedLeafClassificationInput;
}): CommitLegalityOutcome;
/**
 * Ported from `validate_standalone_proposal_account_identity_proof` (Add
 * branch; D-08/D-09): validates the `0x8009` proof of every Add proposal's
 * `KeyPackage` against `ciphersuite`, pure and non-throwing. Used pre-apply by
 * the standalone-proposal admission seams (`src/engine/admin-policy.ts`
 * inbound, `src/engine/group-engine.ts` local propose path) so a bad Add
 * never reaches the queued-proposal state in the first place — the commit-time
 * tree diff in {@link validateCommitAccountIdentityProofs} still catches it
 * after apply if either admission gate is bypassed, since both call the same
 * underlying {@link validateKeyPackageAccountIdentityProof}.
 *
 * Accepts both bare `Proposal` and `ProposalWithSender` items (normalizes
 * each first) and ignores every non-Add proposal kind. Returns on the first
 * failing Add; `leafIndex` is always omitted (the KeyPackage has no tree
 * position yet, pre-apply).
 *
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs `validate_membership_proposal`
 */
export declare function validateAddProposalAccountIdentityProofs(proposals: readonly (Proposal | ProposalWithSender)[], ciphersuite: number): CommitIntegrityViolation | undefined;
/**
 * The Update branch of `validate_standalone_proposal_account_identity_proof`
 * (UPD-04, D-09/D-10) — the sibling of {@link validateAddProposalAccountIdentityProofs}
 * for standalone Update proposals. Pure and non-throwing. Used pre-apply by
 * the same two standalone-proposal admission seams (`src/engine/admin-policy.ts`
 * inbound, `src/engine/group-engine.ts` local propose path) so a bad Update —
 * an unattributable sender, an invalid `0x8009` proof, or a replacement leaf
 * bound to a different account identity — never reaches the queued-proposal
 * state. The commit-time tree diff in
 * {@link validateCommitAccountIdentityProofs} still catches a bad Update
 * after apply if either admission gate is bypassed; both entry points enforce
 * the same rule.
 *
 * Deliberately returns `CommitIntegrityViolation | undefined`, NOT the
 * {@link CommitLegalityOutcome} tri-state: per D-10, pre-apply admission is
 * branch-independent — there is no candidate parent whose later arrival could
 * make an unresolvable-sender Update proposal judgeable, so there is no
 * deferral case here (unlike {@link validateCommitAccountIdentityProofs}'s
 * `undecidable` outcome, which exists because a commit MAY later become
 * classifiable against a different candidate parent).
 *
 * Accepts both bare `Proposal` and `ProposalWithSender` items (normalizes
 * each first) and ignores every non-Update proposal kind. Returns on the
 * first failing Update, in this order:
 * 1. the sender must be attributable — a normalized item with an undefined
 *    `senderLeafIndex` is rejected as `unattributable-leaf` (D-10 rejects
 *    rather than defers, matching `admin-policy.ts`'s self_remove
 *    sender-resolution template);
 * 2. the sender's CURRENT identity is resolved via
 *    `getCredentialFromLeafIndex(ratchetTree, senderLeafIndex)` +
 *    {@link getCredentialPubkey}; any throw (a blank or out-of-range leaf, a
 *    non-basic credential) is also `unattributable-leaf`;
 * 3. the replacement leaf's own `0x8009` proof is validated with
 *    {@link validateLeafAccountIdentityProof}; an `AccountIdentityProofError`
 *    carries its `reason` as `proofReason`, any other throw omits it;
 * 4. the replacement leaf's credential identity is compared against the
 *    resolved sender identity; a throw is `invalid-credential`, a mismatch is
 *    `member-identity-changed` — the same literal the commit-time path uses
 *    for the same spec rule (account-identity-proof-v2.md "a change of
 *    account identity is not a self-update"), so the two admission points
 *    cannot report the same violation differently.
 *
 * `leafIndex` is omitted throughout (D-06): the proposal has not been
 * applied, so the replacement leaf has no tree position yet, matching the Add
 * sibling's documented convention. Every `detail` string names only the
 * positional proposal index and the reason — never a pubkey, credential
 * bytes, or `err.message`.
 *
 * @see refs/mdk/crates/cgka-engine/src/account_identity_proof.rs `validate_standalone_proposal_account_identity_proof`
 * @see refs/marmot/app-components/account-identity-proof-v2.md "Lifecycle, authorization, and removal"
 */
export declare function validateUpdateProposalAccountIdentityProofs(proposals: readonly (Proposal | ProposalWithSender)[], ratchetTree: ClientState["ratchetTree"], ciphersuite: number): CommitIntegrityViolation | undefined;
/**
 * The current-profile invariants of a commit's COMPLETE resulting state,
 * mirroring MDK `validate_current_profile_invariants_for_staged_commit`, which
 * every MDK seam (send, ingest, convergence replay) runs before a commit can
 * become canonical:
 *
 * - `required_capabilities` exists and requires `app_data_dictionary` and
 *   `app_data_update`;
 * - the dictionary exists, its `app_components` list decodes, it requires
 *   admin-policy (`0x8003`) and the account proof (`0x8009`), and neither
 *   requires nor carries the frozen encrypted-media v1 (`0x8008`);
 * - every required component other than `0x8009` is a known group component
 *   and has GroupContext state;
 * - EVERY resulting leaf advertises each required non-default MLS extension,
 *   proposal and credential type, and every required component id in its own
 *   `app_components` support list.
 *
 * ts-mls checks the MLS `required_capabilities` only for leaves a commit adds,
 * and knows nothing about Marmot app components. Without this check marmot-ts
 * applied commits MDK rejects (an Add of a KeyPackage that does not advertise
 * a required component, an AppDataUpdate that requires a component some
 * member lacks), and the group split.
 *
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs `validate_current_profile_group_context`, `validate_resulting_leaf_capabilities`
 * @see refs/marmot/app-components/README.md
 */
export declare function validateResultingProfileInvariants(args: {
    resultingExtensions: GroupContextExtension[];
    resultingTree: ClientState["ratchetTree"];
}): CommitIntegrityViolation | undefined;
export declare function validateCommitLegality(args: {
    parentState: ClientState;
    resultingState: ClientState;
    proposals: readonly (Proposal | ProposalWithSender)[];
    committerLeafIndex?: number;
}): CommitLegalityOutcome;
