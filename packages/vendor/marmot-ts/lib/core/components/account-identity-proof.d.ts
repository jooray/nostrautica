import { type ClientState, type GroupContextExtension, type KeyPackage, type LeafNode } from "../../vendor/ts-mls/index.js";
import { type AuthorizationProofSigner, type AuthorizationProofTemplate } from "../authorization-proof.js";
/**
 * The reason a `0x8009` account identity proof (or a GroupContext/KeyPackage location
 * check) was rejected. One literal per spec validation step — never a coarse bucket. The
 * nine D-13 minimum reasons (`invalid-location`, `missing-support`, `missing-data`,
 * `duplicate-data`, `ciphersuite-mismatch`, `signature-key-mismatch`, `identity-mismatch`,
 * `invalid-proof`, `legacy-extension-present`) are all present; `invalid-credential`,
 * `invalid-dictionary`, `legacy-group`, `mixed-profile`, and `missing-requirement` are the
 * additions D-13 allows.
 *
 * Phase 9 (UPD-01) adds two more, both emitted by the commit-legality bucket
 * classifier in `./integrity.js`, not by any validator in this module:
 * - `member-identity-changed` (D-05): the replacement leaf at an existing
 *   member's index carries a different account identity than the leaf it
 *   replaced. Deliberately NOT `identity-mismatch` — that literal means the
 *   proof's signer does not match this leaf's own credential identity (a
 *   single-leaf check). Conflating the two would collapse a membership-model
 *   violation into a proof-binding error.
 * - `unattributable-leaf` (D-02): a changed leaf that, with the commit's full
 *   proposal list and committer index available, matches no Add proposal, no
 *   Update proposal sender, and is not the committer's update-path leaf —
 *   fail closed.
 */
export type AccountIdentityProofRejectReason = "invalid-credential" | "legacy-extension-present" | "invalid-dictionary" | "duplicate-data" | "missing-support" | "missing-data" | "invalid-location" | "ciphersuite-mismatch" | "signature-key-mismatch" | "identity-mismatch" | "invalid-proof" | "legacy-group" | "mixed-profile" | "missing-requirement" | "member-identity-changed" | "unattributable-leaf";
/** Thrown for every rejection in this module. */
export declare class AccountIdentityProofError extends Error {
    readonly reason: AccountIdentityProofRejectReason;
    constructor(message: string, reason: AccountIdentityProofRejectReason, options?: ErrorOptions);
}
/**
 * The account-identity-proof profile a GroupContext (or, per-leaf, a LeafNode) classifies
 * as: `"current"` (`0x8009` required/present, no `0xf2f1`), `"legacy"` (`0xf2f1` required,
 * no `0x8009`), `"mixed"` (both), or `"neither"`.
 */
export type AccountIdentityProofProfile = "current" | "legacy" | "mixed" | "neither";
/** The container an `assertNoAccountIdentityProofComponent` location guard checks. */
export type AccountIdentityProofLocation = "group-context" | "key-package" | "group-info";
/** Returns the MLS signature scheme code point for a ciphersuite id. */
export declare function mlsSignatureSchemeForCiphersuite(ciphersuite: number): number;
/**
 * Builds the exact `marmot.member.account-identity-proof.v2` kind-450 signing template for
 * a ciphersuite and MLS leaf signature key. Returns a fresh object (and fresh tag arrays)
 * on every call, so mutating one call's result never affects another's.
 *
 * @see refs/marmot/app-components/account-identity-proof-v2.md "Signing event"
 */
export declare function accountIdentityProofTemplate(ciphersuite: number, mlsSignatureKey: Uint8Array): AuthorizationProofTemplate;
/** Parameters for {@link produceAccountIdentityProof}. */
export interface ProduceAccountIdentityProofParams {
    signer: AuthorizationProofSigner;
    /** The 32-byte x-only Nostr account pubkey (the credential identity). */
    accountIdentity: Uint8Array;
    /** The MLS leaf signature public key this proof binds to the account. */
    mlsSignatureKey: Uint8Array;
    ciphersuite: number;
    /** Injected Unix timestamp in seconds; defaults to the current time (D-03). */
    createdAt?: number;
}
/**
 * Produces a `0x8009` account identity proof: builds the exact signing template (rejecting
 * an unknown ciphersuite before the signer is ever invoked), asks `params.signer` to sign
 * it via the shared `MarmotAuthorizationProof` primitive, and returns the 104-byte encoded
 * component ready to carry in a LeafNode `app_data_dictionary` entry.
 *
 * A throw from `produceAuthorizationProof` (a signing failure — malformed signer return,
 * substituted fields, bad signature) propagates unchanged as `AuthorizationProofError`; it
 * is not wrapped into `AccountIdentityProofError`, since it is a signer problem, not a leaf
 * rejection.
 */
export declare function produceAccountIdentityProof(params: ProduceAccountIdentityProofParams): Promise<Uint8Array>;
/**
 * Validates a `0x8009` account identity proof on a single MLS LeafNode against an explicit
 * ciphersuite (D-16: never inferred from the leaf itself). Throws `AccountIdentityProofError`
 * on the first failing check, in the exact order documented below.
 *
 * @see refs/marmot/app-components/account-identity-proof-v2.md "Validation"
 */
export declare function validateLeafAccountIdentityProof(leaf: LeafNode, ciphersuite: number): void;
/**
 * True iff `holder`'s own extension list carries any account-identity-proof material at all:
 * the legacy `0xf2f1` extension, a `0x8009` dictionary entry, or a dictionary that fails to
 * decode (fail closed — an undecodable dictionary might be hiding proof material). Does not
 * itself validate the material; use {@link validateLeafAccountIdentityProof} or
 * {@link validateKeyPackageAccountIdentityProof} for that.
 *
 * Accepts a LeafNode or a KeyPackage. It only inspects `holder.extensions`, so for a
 * KeyPackage it reports KeyPackage-level (misplaced or legacy) material, not material on the
 * embedded leaf — check `keyPackage.leafNode` separately.
 */
export declare function hasAccountIdentityProofMaterial(holder: {
    readonly extensions: readonly {
        extensionType: number;
    }[];
}): boolean;
/**
 * Rejects `0x8009` account identity proof data appearing anywhere it is not valid: the
 * GroupContext dictionary, KeyPackage-level extensions, or a GroupInfo extension list
 * (PROOF-06, D-08). `location` names the container in the thrown message. Structurally
 * accepts any of ts-mls's GroupContext, GroupInfo, LeafNode, or KeyPackage extension array
 * types (all are `{ extensionType: number, ... }[]`).
 */
export declare function assertNoAccountIdentityProofComponent(extensions: readonly {
    extensionType: number;
}[], location: AccountIdentityProofLocation): void;
/**
 * Validates a `0x8009` account identity proof carried on a KeyPackage: rejects an explicit
 * `expectedCiphersuite` mismatch, a legacy `0xf2f1` or `0x8009` entry at the KeyPackage
 * level (PROOF-05), then validates the embedded LeafNode using the KeyPackage's own
 * ciphersuite (D-16 — never a caller-supplied "current" ciphersuite).
 */
export declare function validateKeyPackageAccountIdentityProof(keyPackage: KeyPackage, expectedCiphersuite?: number): void;
/**
 * Validates the `0x8009` account identity proof of every member leaf in `state`. Throws on
 * the first invalid leaf, wrapping the original `AccountIdentityProofError` as `cause` and
 * naming only the member's tree position — never a pubkey (T-07-08).
 */
export declare function validateGroupMemberAccountIdentityProofs(state: ClientState, ciphersuite: number): void;
/**
 * Classifies a GroupContext's account-identity-proof profile from its extensions, modelled
 * on MDK's `protocol_profile_of_group_extensions` (D-07): `"current"` (0x8009 required, no
 * legacy requirement), `"legacy"` (0xf2f1 required, no 0x8009 requirement), `"mixed"`
 * (both), or `"neither"`. Throws `invalid-location` if the GroupContext dictionary itself
 * carries `0x8009` data (Pitfall 9) — that is always a class-level violation, not a profile.
 */
export declare function classifyGroupAccountIdentityProofProfile(extensions: GroupContextExtension[]): AccountIdentityProofProfile;
/**
 * Throws unless `extensions` classify as the `"current"` account-identity-proof profile
 * (D-07, D-13): `"legacy"` -> `legacy-group`, `"mixed"` -> `mixed-profile`, `"neither"` ->
 * `missing-requirement`.
 */
export declare function assertCurrentGroupAccountIdentityProofProfile(extensions: GroupContextExtension[]): void;
/**
 * The result of a non-throwing classification of whether a GroupContext's
 * extensions support the current account-identity-proof profile.
 */
export type GroupProfileSupport = {
    kind: "supported";
} | {
    kind: "unsupported";
    proofReason: AccountIdentityProofRejectReason;
};
/**
 * Non-throwing wrapper over {@link assertCurrentGroupAccountIdentityProofProfile}
 * (D-01a, D-11): returns `{ kind: "supported" }` when `extensions` classify as
 * the current profile, or `{ kind: "unsupported", proofReason }` otherwise —
 * `proofReason` is the caught `AccountIdentityProofError.reason`
 * (`legacy-group`, `mixed-profile`, or `missing-requirement`), or
 * `"invalid-dictionary"` for any other thrown value.
 *
 * Never throws. Two call sites rely on that: `validateCommitLegality`'s D-01a
 * profile check (the sibling commit-legality module), which must stay
 * non-throwing so fork-recovery and tree-fed convergence (neither of which
 * wrap the call) can map a violation instead of aborting, and the D-11
 * load-time classifier that marks a stored group's profile without breaking
 * `Promise.all`-batched loading of every other group.
 *
 * @see refs/mdk/crates/cgka-engine/src/account_identity_proof.rs `protocol_profile_of_group_extensions`
 */
export declare function getGroupProfileSupport(extensions: GroupContextExtension[]): GroupProfileSupport;
