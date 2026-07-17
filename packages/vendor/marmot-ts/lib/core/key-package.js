/** @module @category Core - Key Package */
import { defaultCredentialTypes, defaultCryptoProvider, generateKeyPackage as MLSGenerateKeyPackage, generateKeyPackageWithKey as MLSGenerateKeyPackageWithKey, makeKeyPackageRef, } from "ts-mls";
import { hexToBytes } from "@noble/hashes/utils.js";
import { createThreeMonthLifetime } from "../utils/timestamp.js";
import { buildAccountIdentityProofExtension, } from "./account-identity-proof.js";
import { ensureMarmotCapabilities } from "./capabilities.js";
import { makeLeafAppComponentsExtension } from "./components/index.js";
import { getCredentialPubkey } from "./credential.js";
import { defaultCapabilities } from "./default-capabilities.js";
import { ensureLastResortExtension } from "./extensions.js";
/** Create default extensions for a key package */
export function keyPackageDefaultExtensions() {
    return ensureLastResortExtension([]);
}
/** Calculates a key package reference with the hash implementation based on the key package's cipher suite */
export async function calculateKeyPackageRef(keyPackage, cryptoProvider) {
    const provider = cryptoProvider ?? defaultCryptoProvider;
    const ciphersuiteImpl = await provider.getCiphersuiteImpl(keyPackage.cipherSuite);
    return await makeKeyPackageRef(keyPackage, ciphersuiteImpl.hash);
}
/** Generate a marmot key package that is compliant with MIP-00 */
export async function generateKeyPackage({ credential, capabilities, lifetime, extensions, isLastResort = true, accountProofSigner, ciphersuiteImpl, }) {
    if (credential.credentialType !== defaultCredentialTypes.basic)
        throw new Error("Marmot key packages must use a basic credential");
    // Ensure the credential has a valid pubkey
    const accountPubkey = getCredentialPubkey(credential);
    const resolvedCapabilities = capabilities
        ? ensureMarmotCapabilities(capabilities)
        : defaultCapabilities();
    const resolvedLifetime = lifetime ?? createThreeMonthLifetime();
    // Marmot requires support for last_resort capability signaling (MIP-00),
    // but individual KeyPackages may be single-use or last-resort reusable.
    // `isLastResort` controls whether this KeyPackage is marked reusable.
    const resolvedExtensions = isLastResort
        ? ensureLastResortExtension(extensions ?? [])
        : (extensions ?? []);
    // Advertise the supported app components on the LeafNode so this member can
    // be added to groups that require them (matches darkmatter's leaf state).
    const leafNodeExtensions = [
        makeLeafAppComponentsExtension(),
    ];
    // When an account signer is supplied, generate the leaf signature keypair
    // first, bind it to the Nostr account with an identity proof, and carry the
    // proof on the LeafNode (darkmatter validates this on every leaf).
    if (accountProofSigner) {
        const signatureKeyPair = await ciphersuiteImpl.signature.keygen();
        leafNodeExtensions.push(await buildAccountIdentityProofExtension({
            accountIdentity: hexToBytes(accountPubkey),
            mlsSignaturePublicKey: signatureKeyPair.publicKey,
            ciphersuite: ciphersuiteImpl.id,
            signer: accountProofSigner,
        }));
        return await MLSGenerateKeyPackageWithKey({
            credential,
            capabilities: resolvedCapabilities,
            lifetime: resolvedLifetime,
            extensions: resolvedExtensions,
            signatureKeyPair,
            leafNodeExtensions,
            cipherSuite: ciphersuiteImpl,
        });
    }
    // In v2, generateKeyPackage takes a single params object
    return await MLSGenerateKeyPackage({
        credential,
        capabilities: resolvedCapabilities,
        lifetime: resolvedLifetime,
        extensions: resolvedExtensions,
        leafNodeExtensions,
        cipherSuite: ciphersuiteImpl,
    });
}
//# sourceMappingURL=key-package.js.map