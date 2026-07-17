import { Credential, CredentialBasic } from "ts-mls";
export declare function isHexKey(str: string): boolean;
/**
 * Whether `identity` is a valid Marmot account identity: exactly 32 bytes and a
 * valid x-only secp256k1 public key (it lifts to a point on the curve via
 * BIP-340 `lift_x`). `foundation/identity.md`: "clients reject credentials whose
 * identity is not a valid x-only secp256k1 public key." Mirrors darkmatter
 * `validate_credential_identity` (`k256::schnorr::VerifyingKey::from_bytes`).
 */
export declare function isValidAccountIdentity(identity: Uint8Array): boolean;
/** Creates a MLS basic credential from a nostr public key. */
export declare function createCredential(pubkey: string): CredentialBasic;
/** Gets the nostr public key from a credential. */
export declare function getCredentialPubkey(credential: Credential): string;
/** Checks if two credentials are the same. */
export declare function isSameCredential(a: Credential, b: Credential): boolean;
