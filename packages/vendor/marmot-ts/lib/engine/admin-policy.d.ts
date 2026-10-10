/** @module @category Engine */
import { type ClientState, type IncomingMessageCallback, type Proposal, type ProposalWithSender } from "../vendor/ts-mls/index.js";
import { type AppComponentId } from "../core/components/ids.js";
import { type CommitIntegrityViolation } from "../core/components/integrity.js";
/**
 * Payload decoders for every app component whose format this library knows.
 * An AppDataUpdate for an id outside this table is opaque to the library and
 * left to the application (`app-components/README.md` "Unknown Data").
 */
export declare const COMPONENT_PAYLOAD_DECODERS: ReadonlyMap<number, (data: Uint8Array) => unknown>;
/**
 * The parent epoch's required app-component ids, in the shape
 * {@link validatePreApplyProposals} consumes — or `[]` when the
 * `app_components` bytes do not decode.
 *
 * Failing soft here is deliberate and is NOT a bypass: an undecodable
 * `app_components` list is separately reported as a `component-integrity`
 * violation by `validateCommitLegality` (`src/core/components/integrity.ts`),
 * which every commit seam also runs. Throwing here instead would escape the
 * convergence/replay seams that call this validator unwrapped.
 */
export declare function requiredComponentIdsOf(state: ClientState): readonly AppComponentId[];
/**
 * The pre-apply, parent-independent admission checks every proposal —
 * standalone or carried by a commit, inbound or locally built — must pass
 * before it is staged, applied, or published (CR-03/CR-02). Returns the first
 * violation, in this order:
 *
 * 1. every Add's KeyPackage carries a valid `0x8009` proof
 *    ({@link validateAddProposalAccountIdentityProofs}, D-08/D-09);
 * 2. no component id carries more than one `AppDataUpdate` operation in the
 *    batch, and `app_components` (`0x0001`) is never removed (MDK batch loop 1);
 * 3. every `update` targets an id that is legal GroupContext state
 *    ({@link NON_GROUP_CONTEXT_COMPONENT_IDS}) and, for a known component id,
 *    carries a payload that decodes with that component's codec. Without this,
 *    one AppDataUpdate — which the admin gate admits from any member as a
 *    standalone proposal, and which a later commit bundles by reference —
 *    could poison the group dictionary with bytes no member can decode;
 * 4. every `remove` targets an id that is neither structurally unremovable
 *    ({@link UNREMOVABLE_COMPONENT_IDS}) nor present in the RESULTING required
 *    list (MDK batch loop 2).
 *
 * `requiredIds` is the PARENT epoch's required-component list
 * ({@link requiredComponentIdsOf}). Removal legality is then measured against
 * the list the batch itself produces — this batch's own `0x0001` update wins
 * over `requiredIds` — so the spec's atomic "un-require and remove in the same
 * commit" stays legal while removing a still-required component does not.
 * Omitting `requiredIds` yields MDK's *standalone* admission semantics
 * (`validate_standalone_app_data_update`, which passes an empty set): a lone
 * proposal cannot be judged against a batch it is not yet part of, and the
 * commit that bundles it re-runs this validator with the real list.
 *
 * Shared by the admin callback, by every seam that labels a callback
 * rejection, and by the outbound commit/proposal seams, so the verdict and its
 * reason cannot differ per seam.
 *
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs `validate_app_data_update_batch_against`, `validate_app_component_remove_against`, `validate_app_component_bytes`, `validate_membership_proposal`
 */
export declare function validatePreApplyProposals(proposals: readonly (Proposal | ProposalWithSender)[], ciphersuiteId: number, requiredIds?: readonly AppComponentId[]): CommitIntegrityViolation | undefined;
/**
 * Why a proposal's SENDER may not make it, or `undefined` when it may.
 *
 * Mirrors MDK `authorize_proposal`, which runs for every standalone proposal
 * against its source epoch and again for every proposal a commit carries
 * (by reference or inline), always against the proposal's own authenticated
 * sender rather than the committer:
 *
 * - SelfRemove: any member except an active admin (an admin drops admin first);
 * - Add, Remove, Update, GroupContextExtensions and AppDataUpdate: active
 *   admins only. In v1 the only standalone proposal a non-admin may send is
 *   SelfRemove (`protocol-core/group-messaging.md` "Commit authorization");
 * - a lifecycle (`0x800c`) AppDataUpdate must be inline in the commit that
 *   realizes it, so it is never valid standalone or by reference;
 * - PreSharedKey, ReInit, ExternalInit and any other type: unsupported.
 *
 * Without this, a non-admin's standalone Remove or AppDataUpdate was staged
 * and then bundled by reference into the next commit a marmot-ts admin made;
 * MDK rejects that commit (`authorize_staged_commit_proposals`) and the group
 * splits.
 *
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs `authorize_proposal`
 * @see refs/marmot/app-components/README.md "Authorization Evaluation"
 */
export declare function proposalSenderViolation(proposal: Proposal, senderIsAdmin: boolean, standalone: boolean): string | undefined;
/**
 * The first proposal-sender violation in `proposals`, each judged against its
 * own sender in the state whose `ratchetTree` and admin set are given (the
 * proposal's source epoch, which for a commit is the candidate parent).
 */
export declare function findProposalSenderViolation(proposals: readonly ProposalWithSender[], ratchetTree: ClientState["ratchetTree"], adminPubkeys: readonly string[], standalone: boolean): string | undefined;
/**
 * Build an incoming-message callback that enforces
 * `refs/marmot/protocol-core/group-messaging.md` "admin-only commits".
 *
 * Every Add — whether committed or proposed standalone — is validated
 * before apply with the same core validator
 * ({@link validateAddProposalAccountIdentityProofs}) that `proposeInviteUser`
 * (the invite seam) and the post-apply tree-diff adapter
 * (`src/core/components/integrity.ts` `validateCommitAccountIdentityProofs`)
 * use, so a bad Add cannot reach the queued-proposal or applied-tree state
 * through this callback regardless of which of the two `IncomingMessageCallback`
 * kinds it arrives as (D-08/D-09).
 *
 * @see refs/marmot/protocol-core/group-messaging.md "admin-only commits"
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs `validate_membership_proposal`
 */
export declare function createAdminCommitPolicyCallback(args: {
    ratchetTree: ClientState["ratchetTree"];
    adminPubkeys: string[];
    ciphersuiteId: number;
    onUnverifiableCommit?: "reject" | "retry";
    /**
     * The PARENT epoch's required app-component ids
     * ({@link requiredComponentIdsOf}), used by the commit branch to judge
     * `AppDataUpdate` removal legality. Defaults to `[]`, which reproduces the
     * pre-CR-01 behaviour of not enforcing the required-component removal rule.
     */
    requiredIds?: readonly AppComponentId[];
}): IncomingMessageCallback;
/**
 * A pure side-channel decorator around an `IncomingMessageCallback`, used to
 * capture a commit's own proposals for the WIRE-03/CONV-01 commit-legality
 * validators (`src/core/components/integrity.ts`).
 *
 * WHY this exists: ts-mls has no OpenMLS `StagedCommit` equivalent —
 * `processMessage` returns the fully-applied `newState` in one step, and
 * `IncomingMessageCallback` is the only pre-apply hook, but it never sees the
 * resulting `GroupContext`. `validateCommitLegality` needs both the
 * pre-apply (`parentState`) and post-apply (`resultingState`) `ClientState`,
 * plus the commit's own proposals, so it can only run AFTER `processMessage`
 * resolves. This wrapper's sole job is to make the commit's proposals
 * available at that later point — it is a side channel, not a policy
 * decision. It feeds the same algorithm ported from MDK's
 * `refs/mdk/crates/cgka-engine/src/app_components.rs`
 * `validate_app_component_integrity_for_staged_commit`.
 *
 * `callback` delegates every decision to `inner` unchanged — this is a
 * decorator, NOT a policy change. The
 * `refs/marmot/protocol-core/group-messaging.md` admin gate, the
 * account-identity-proof check, and the admin-self-remove guard in
 * `createAdminCommitPolicyCallback` all keep their exact current behavior.
 * Its only extra effect: BEFORE returning `inner(incoming)`, it appends the
 * proposal(s) to a private buffer — for `incoming.kind === "commit"`,
 * `incoming.proposals.map((p) => p.proposal)`; for `incoming.kind ===
 * "proposal"`, the single `incoming.proposal` — so proposals are captured
 * even for a message `inner` itself rejects.
 *
 * No validation logic may be added inside this wrapper or inside `inner`
 * (Pitfall 1 — validating inside the callback runs before the resulting
 * `GroupContext` exists and would produce wrong verdicts or throw mid-apply).
 *
 * Contract: `take()` returns the buffered proposals and clears the buffer.
 * Callers MUST call `take()` immediately before each `processMessage` call
 * (discarding the result, to clear any stale proposals left over from a
 * prior message) and again immediately after `processMessage` returns (to
 * read exactly the proposals of the commit just processed). This makes it
 * safe to reuse one `callback`/`take()` pair across a loop of several
 * commits processed with the same wrapped callback.
 */
export declare function withCapturedProposals(inner: IncomingMessageCallback): {
    callback: IncomingMessageCallback;
    take(): {
        proposals: ProposalWithSender[];
        committerLeafIndex: number | undefined;
    };
};
