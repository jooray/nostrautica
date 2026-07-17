/** @module @category Client - Key Package Manager */
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { ciphersuites, defaultCryptoProvider, } from "ts-mls";
import { createCredential } from "../core/credential.js";
import { createDeleteKeyPackageEvent, createKeyPackageEvent, } from "../core/key-package-event.js";
import { generateKeyPackage } from "../core/key-package.js";
import { logger } from "../utils/debug.js";
/**
 * The native-sensitive boundary of key package management: generates key
 * package material, builds and signs the kind-30443 advertisement event, and
 * publishes it (or a kind-5 deletion) to relays. Every `signer.signEvent`,
 * `network.publish`, and `randomBytes` site lives here, isolated for audit
 * against darkmatter's `KeyPackagePublisher`.
 */
export class KeyPackagePublisher {
    #signer;
    #network;
    #accountProofSigner;
    #cryptoProvider;
    #log = logger.extend("KeyPackagePublisher");
    constructor(options) {
        this.#signer = options.signer;
        this.#network = options.network;
        this.#accountProofSigner = options.accountProofSigner;
        this.#cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    }
    /** Generates a fresh random addressable slot identifier (`d` tag value). */
    freshIdentifier() {
        return bytesToHex(randomBytes(32));
    }
    /**
     * Generates a new key package bound to this client's Nostr identity,
     * returning the public and private material. Does not persist or publish.
     */
    async generate(options) {
        const pubkey = await this.#signer.getPublicKey();
        const credential = createCredential(pubkey);
        const ciphersuiteImpl = await this.#getCiphersuiteImpl(options?.ciphersuite);
        return generateKeyPackage({
            credential,
            ciphersuiteImpl,
            isLastResort: options?.isLastResort,
            accountProofSigner: this.#accountProofSigner,
        });
    }
    /**
     * Builds, signs and publishes a kind-30443 key package event to the given
     * relays, returning the signed event.
     */
    async publish(options) {
        const eventTemplate = await createKeyPackageEvent({
            keyPackage: options.keyPackage,
            identifier: options.identifier,
            relays: options.relays,
            client: options.client,
            protected: options.protected,
        });
        const signed = await this.#signer.signEvent(eventTemplate);
        await this.#network.publish(options.relays, signed);
        this.#log("published key package event %s with slot %s", signed.id, options.identifier);
        return signed;
    }
    /**
     * Builds, signs and publishes a single NIP-09 deletion covering the given
     * key package events to the given relays, returning the signed event.
     */
    async delete(events, relays) {
        const draft = createDeleteKeyPackageEvent({ events });
        const signed = await this.#signer.signEvent(draft);
        await this.#network.publish(relays, signed);
        this.#log("published delete event %s for %d events", signed.id, events.length);
        return signed;
    }
    async #getCiphersuiteImpl(name) {
        const ciphersuiteName = name ?? "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";
        const id = ciphersuites[ciphersuiteName];
        return this.#cryptoProvider.getCiphersuiteImpl(id);
    }
}
//# sourceMappingURL=key-package-publisher.js.map