/** @module @category Core - Key Package */
import { Capabilities, Credential, CryptoProvider, CiphersuiteImpl, CustomExtension, KeyPackage, Lifetime, PrivateKeyPackage } from "ts-mls";
import { type AccountIdentityProofSigner } from "./account-identity-proof.js";
/**
 * A complete key package containing both public and private components.
 *
 * The public package can be shared with others to add this participant to groups,
 * while the private package must be kept secret and is used for decryption and signing.
 */
export type CompleteKeyPackage = {
    /** The public key package that can be shared with others */
    publicPackage: KeyPackage;
    /** The private key package that must be kept secret */
    privatePackage: PrivateKeyPackage;
};
/** Create default extensions for a key package */
export declare function keyPackageDefaultExtensions(): CustomExtension[];
/** Calculates a key package reference with the hash implementation based on the key package's cipher suite */
export declare function calculateKeyPackageRef(keyPackage: KeyPackage, cryptoProvider?: CryptoProvider): Promise<Uint8Array>;
/** Options for generating a marmot key package */
export type GenerateKeyPackageOptions = {
    credential: Credential;
    capabilities?: Capabilities;
    lifetime?: Lifetime;
    extensions?: CustomExtension[];
    /**
     * Whether to mark this KeyPackage as reusable using the MLS `last_resort` extension.
     *
     * - `true`: include the `last_resort` KeyPackage extension (reusable; helps with race windows)
     * - `false`: omit the extension (single-use; private init_key is expected to be consumed)
     *
     * Default: `true` for backwards compatibility with existing marmot-ts behavior.
     */
    isLastResort?: boolean;
    /**
     * Optional Nostr-account signer. When provided, the generated key package
     * carries a `marmot.account-identity-proof.v1` LeafNode extension binding the
     * credential's Nostr account to the leaf signature key — required for wire
     * interop with darkmatter, which validates this proof on every leaf.
     */
    accountProofSigner?: AccountIdentityProofSigner;
    ciphersuiteImpl: CiphersuiteImpl;
};
/** Generate a marmot key package that is compliant with MIP-00 */
export declare function generateKeyPackage({ credential, capabilities, lifetime, extensions, isLastResort, accountProofSigner, ciphersuiteImpl, }: GenerateKeyPackageOptions): Promise<CompleteKeyPackage>;
