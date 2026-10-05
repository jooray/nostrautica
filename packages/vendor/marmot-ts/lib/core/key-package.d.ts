/** @module @category Core - Key Package */
import { Capabilities, Credential, CryptoProvider, CiphersuiteImpl, CustomExtension, KeyPackage, Lifetime, PrivateKeyPackage } from "../vendor/ts-mls/index.js";
import type { AuthorizationProofSigner } from "./authorization-proof.js";
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
     * Whether to mark this KeyPackage as reusable (last-resort).
     *
     * - `true`: add the empty `last_resort_key_package` component (`0x0004`) to an
     *   `app_data_dictionary` KeyPackage extension (reusable; helps with race windows)
     * - `false`: omit the marker (single-use; private init_key is expected to be consumed)
     *
     * Default: `true` for backwards compatibility with existing marmot-ts behavior.
     */
    isLastResort?: boolean;
    /**
     * The Nostr account signer that proves this KeyPackage's leaf by signing the
     * kind-450 account identity proof through `signEvent`; its public key MUST
     * equal the credential identity. Any signEvent-capable signer works (a local
     * key signer, NIP-07, NIP-46).
     */
    signer: AuthorizationProofSigner;
    /**
     * Injected `created_at` (Unix seconds) for the account identity proof.
     * Defaults to the current time. Core-only: meant for byte-stable tests and
     * fixtures; the client layer does not expose this option.
     */
    createdAt?: number;
    ciphersuiteImpl: CiphersuiteImpl;
};
/**
 * Generates a Marmot KeyPackage carrying a `0x8009` account identity proof on
 * its LeafNode.
 *
 * @see refs/marmot/foundation/key-packages.md
 * @see refs/marmot/app-components/account-identity-proof-v2.md
 */
export declare function generateKeyPackage({ credential, capabilities, lifetime, extensions, isLastResort, signer, createdAt, ciphersuiteImpl, }: GenerateKeyPackageOptions): Promise<CompleteKeyPackage>;
