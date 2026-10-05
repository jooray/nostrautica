/** @module @category Core - Key Package Event */
import { NostrEvent } from "applesauce-core/helpers/event";
import { CiphersuiteId, KeyPackage, Lifetime } from "../vendor/ts-mls/index.js";
import { KeyPackageClient, MLS_VERSIONS } from "./protocol.js";
/** Get the KeyPackage from a kind 30443 event */
export declare function getKeyPackage(event: NostrEvent): KeyPackage;
/**
 * Reads the inbound MLS `Lifetime` ({@link Lifetime}) from a kind 30443
 * event's decoded KeyPackage leaf node (WIRE-01 inbound read). Returns
 * `undefined` when the event cannot be decoded as a KeyPackage — never
 * throws, matching the project's typed-reject convention for boundary
 * readers (D-08).
 */
export declare function getKeyPackageLifetime(event: NostrEvent): Lifetime | undefined;
/** Gets the MLS protocol version from a kind 30443 event */
export declare function getKeyPackageMLSVersion(event: NostrEvent): MLS_VERSIONS | undefined;
/** Gets the MLS cipher suite from a kind 30443 event */
export declare function getKeyPackageCipherSuiteId(event: NostrEvent): CiphersuiteId | undefined;
/** Gets the MLS extensions for a kind 30443 event */
export declare function getKeyPackageExtensions(event: NostrEvent): number[] | undefined;
/** Gets the relays for a kind 30443 event */
export declare function getKeyPackageRelays(event: NostrEvent): string[] | undefined;
/** Gets the client for a kind 30443 event */
export declare function getKeyPackageClient(event: NostrEvent): KeyPackageClient | undefined;
/**
 * Gets the addressable slot identifier (`d` tag) from a kind 30443 event.
 */
export declare function getKeyPackageIdentifier(event: NostrEvent): string | undefined;
/**
 * Gets the nostr public key from a key package event.
 *
 * @param event - The key package event (kind 30443)
 * @returns The nostr public key (hex string)
 * @throws Error if the credential is not a basic credential
 */
export declare function getKeyPackageNostrPubkey(event: NostrEvent): string;
/**
 * Returns the KeyPackageRef (the `i` tag value, `transports/nostr.md`) from a kind 30443
 * KeyPackage event.
 *
 * Per `transports/nostr.md` (KeyPackage publication), KeyPackage events MUST include this tag.
 */
export declare function getKeyPackageReference(event: NostrEvent): string | undefined;
