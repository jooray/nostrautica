import { type ClientState, type CustomExtension, type LeafNode } from "ts-mls";
/**
 * The Marmot account identity proof, carried as a custom MLS LeafNode extension
 * (`marmot.account-identity-proof.v1`).
 *
 * An MLS BasicCredential names a Marmot (Nostr) account, but the MLS signature
 * key is a separate per-leaf key. This extension binds the two by having the
 * Nostr account key sign — with BIP-340 Schnorr — a digest over the account
 * pubkey and the leaf signature key, so account-scoped policy (e.g. admin
 * authorization) can trust the credential identity.
 *
 * Wire (`encode_proof`, fixed-width, big-endian):
 *   uint8  version;                       // 1
 *   uint16 ciphersuite;
 *   uint16 signature_scheme;
 *   opaque account_identity[32];          // x-only Nostr pubkey, no length prefix
 *   uint16 mls_signature_public_key_len;
 *   opaque mls_signature_public_key[len];
 *   opaque signature[64];                 // BIP-340 Schnorr
 *
 * @see darkmatter `crates/cgka-engine/src/account_identity_proof.rs`
 */
export declare const ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE = 62193;
/** Returns the MLS signature scheme code point for a ciphersuite id. */
export declare function mlsSignatureScheme(ciphersuite: number): number;
/** The values a Marmot account key signs to bind an MLS leaf to that account. */
export interface AccountIdentityProofRequest {
    /** The 32-byte x-only Nostr account pubkey (the credential identity). */
    accountIdentity: Uint8Array;
    /** The MLS leaf signature public key. */
    mlsSignaturePublicKey: Uint8Array;
    /** The MLS ciphersuite id. */
    ciphersuite: number;
    /** The MLS signature scheme code point (see {@link mlsSignatureScheme}). */
    signatureScheme: number;
}
/** A decoded account identity proof: the signed request plus its signature. */
export interface AccountIdentityProof {
    request: AccountIdentityProofRequest;
    /** 64-byte BIP-340 Schnorr signature by the account key. */
    signature: Uint8Array;
}
/** A hook that signs the proof digest with the Nostr account key (BIP-340). */
export type AccountIdentityProofSigner = (request: AccountIdentityProofRequest) => Uint8Array | Promise<Uint8Array>;
/** The 32-byte BIP-340 message digest the account key signs. */
export declare function accountIdentityProofSigningDigest(request: AccountIdentityProofRequest): Uint8Array;
/** Signs a proof request with a raw 32-byte Nostr secret key (BIP-340 Schnorr). */
export declare function signAccountIdentityProof(request: AccountIdentityProofRequest, secretKey: Uint8Array): Uint8Array;
/** Encodes an {@link AccountIdentityProof} to its LeafNode extension bytes. */
export declare function encodeAccountIdentityProof(proof: AccountIdentityProof): Uint8Array;
/** Decodes account identity proof LeafNode extension bytes. */
export declare function decodeAccountIdentityProof(data: Uint8Array): AccountIdentityProof;
/** Builds the `marmot.account-identity-proof.v1` LeafNode extension. */
export declare function makeAccountIdentityProofExtension(proof: AccountIdentityProof): CustomExtension;
/**
 * Builds the account identity proof request for a leaf, signs it with the given
 * account signer, and returns the LeafNode extension. The MLS ciphersuite id and
 * leaf signature key are bound into the proof.
 */
export declare function buildAccountIdentityProofExtension(params: {
    accountIdentity: Uint8Array;
    mlsSignaturePublicKey: Uint8Array;
    ciphersuite: number;
    signer: AccountIdentityProofSigner;
}): Promise<CustomExtension>;
/**
 * Verifies a leaf's account identity proof: the embedded account identity and
 * MLS signature key match the leaf, the ciphersuite/scheme match, and the
 * BIP-340 signature verifies under the credential's x-only Nostr pubkey.
 *
 * Throws on any mismatch. Mirrors darkmatter
 * `validate_leaf_account_identity_proof`.
 */
export declare function verifyLeafAccountIdentityProof(leaf: LeafNode, ciphersuite: number): void;
/**
 * Verifies the Marmot account identity proof on every member leaf in the group.
 *
 * The spec requires a valid proof on every member leaf and KeyPackage — "there
 * is no legacy fallback" (foundation/account-identity-proof-v1.md §Validation).
 * Throws on the first leaf whose proof is missing or invalid, naming the member.
 */
export declare function verifyAllLeafAccountIdentityProofs(state: ClientState, ciphersuite: number): void;
