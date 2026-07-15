import { EventSigner } from "applesauce-core";
import { NostrEvent } from "applesauce-core/helpers/event";
import { CiphersuiteName, CryptoProvider, KeyPackage, PrivateKeyPackage } from "ts-mls";
import type { AccountIdentityProofSigner } from "../core/account-identity-proof.js";
import { NostrNetworkInterface } from "./nostr-interface.js";
/** Options for constructing a {@link KeyPackagePublisher}. */
export type KeyPackagePublisherOptions = {
    /** The signer used for the client's Nostr identity */
    signer: EventSigner;
    /** The nostr relay pool used to publish key package and deletion events */
    network: NostrNetworkInterface;
    /**
     * Optional Nostr-account proof signer. When provided, generated key packages
     * carry a `marmot.account-identity-proof.v1` LeafNode extension binding the
     * account to the leaf signature key (required for darkmatter wire interop).
     */
    accountProofSigner?: AccountIdentityProofSigner;
    /** The crypto provider to use for cryptographic operations */
    cryptoProvider?: CryptoProvider;
};
/** A freshly generated key package and its private material. */
export type GeneratedKeyPackage = {
    publicPackage: KeyPackage;
    privatePackage: PrivateKeyPackage;
};
/** Options for {@link KeyPackagePublisher.generate}. */
export type GenerateKeyPackageOptions = {
    /** Ciphersuite to use (default: MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519) */
    ciphersuite?: CiphersuiteName;
    /** Whether to mark the key package with the MLS last_resort extension (default: true) */
    isLastResort?: boolean;
};
/** Options for {@link KeyPackagePublisher.publish}. */
export type PublishKeyPackageOptions = {
    /** The public key package to advertise */
    keyPackage: KeyPackage;
    /** Addressable slot identifier (`d` tag value) for the kind 30443 event */
    identifier: string;
    /** Relay URLs where the key package event will be published */
    relays: string[];
    /** Client identifier string to include in the key package event */
    client?: string;
    /** Whether to include the NIP-70 protected tag on the event */
    protected?: boolean;
};
/**
 * The native-sensitive boundary of key package management: generates key
 * package material, builds and signs the kind-30443 advertisement event, and
 * publishes it (or a kind-5 deletion) to relays. Every `signer.signEvent`,
 * `network.publish`, and `randomBytes` site lives here, isolated for audit
 * against darkmatter's `KeyPackagePublisher`.
 */
export declare class KeyPackagePublisher {
    #private;
    constructor(options: KeyPackagePublisherOptions);
    /** Generates a fresh random addressable slot identifier (`d` tag value). */
    freshIdentifier(): string;
    /**
     * Generates a new key package bound to this client's Nostr identity,
     * returning the public and private material. Does not persist or publish.
     */
    generate(options?: GenerateKeyPackageOptions): Promise<GeneratedKeyPackage>;
    /**
     * Builds, signs and publishes a kind-30443 key package event to the given
     * relays, returning the signed event.
     */
    publish(options: PublishKeyPackageOptions): Promise<NostrEvent>;
    /**
     * Builds, signs and publishes a single NIP-09 deletion covering the given
     * key package events to the given relays, returning the signed event.
     */
    delete(events: NostrEvent[], relays: string[]): Promise<NostrEvent>;
}
