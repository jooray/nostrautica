/** @module @category Core - Key Package */
import { defaultCredentialTypes, defaultCryptoProvider, generateKeyPackageWithKey as MLSGenerateKeyPackageWithKey, makeKeyPackageRef, } from "../vendor/ts-mls/index.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { createDefaultKeyPackageLifetime, isLifetimeWithinCap, } from "../utils/timestamp.js";
import { ensureMarmotCapabilities } from "./capabilities.js";
import { makeLeafAppComponentsExtension, produceAccountIdentityProof, } from "./components/index.js";
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
/**
 * Generates a Marmot KeyPackage carrying a `0x8009` account identity proof on
 * its LeafNode.
 *
 * @see refs/marmot/foundation/key-packages.md
 * @see refs/marmot/app-components/account-identity-proof-v2.md
 */
export async function generateKeyPackage({ credential, capabilities, lifetime, extensions, isLastResort = true, signer, createdAt, ciphersuiteImpl, }) {
    if (credential.credentialType !== defaultCredentialTypes.basic)
        throw new Error("Marmot key packages must use a basic credential");
    // Ensure the credential has a valid pubkey
    const accountPubkey = getCredentialPubkey(credential);
    const resolvedCapabilities = capabilities
        ? ensureMarmotCapabilities(capabilities)
        : defaultCapabilities();
    const resolvedLifetime = lifetime ?? createDefaultKeyPackageLifetime();
    // WIRE-01 produce path: the cap must hold regardless of how lifetime is
    // supplied. The default is always within cap, so this check only ever
    // rejects an explicit caller-supplied `lifetime` override (D-09).
    if (!isLifetimeWithinCap(resolvedLifetime))
        throw new Error(`generateKeyPackage: lifetime range ${resolvedLifetime.notAfter - resolvedLifetime.notBefore}s exceeds the 7,261,200s (84-day) cap`);
    // Individual KeyPackages may be single-use or last-resort reusable
    // (`foundation/key-packages.md`); last-resort is a KeyPackage-level marker,
    // not an advertised capability.
    // `isLastResort` controls whether this KeyPackage is marked reusable.
    const resolvedExtensions = isLastResort
        ? ensureLastResortExtension(extensions ?? [])
        : (extensions ?? []);
    // Every leaf carries exactly one 0x8009 account identity proof binding the
    // leaf signature key to the Nostr account (refs/marmot/app-components/
    // account-identity-proof-v2.md; refs/marmot/foundation/key-packages.md).
    // The leaf signature keypair is generated first so the proof can bind it.
    const signatureKeyPair = await ciphersuiteImpl.signature.keygen();
    const proof = await produceAccountIdentityProof({
        signer,
        accountIdentity: hexToBytes(accountPubkey),
        mlsSignatureKey: signatureKeyPair.publicKey,
        ciphersuite: ciphersuiteImpl.id,
        createdAt,
    });
    const leafNodeExtensions = [
        makeLeafAppComponentsExtension(proof),
    ];
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
