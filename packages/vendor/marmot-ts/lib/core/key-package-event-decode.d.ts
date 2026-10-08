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
/**
 * Result of {@link checkKeyPackageProposalsTag}: how a kind 30443 event's
 * `mls_proposals` tag compares to the decoded KeyPackage leaf's advertised
 * proposals.
 */
export type KeyPackageProposalsTagCheck = 
/**
 * The tag matches the leaf. `exact`: the tag's value set equals the leaf's
 * proposals with GREASE included (MDK and current marmot-ts publishers).
 * `grease-stripped`: the sets are equal only after GREASE ids are removed
 * from both sides (older marmot-ts publishers that filtered GREASE out).
 */
{
    kind: "match";
    mode: "exact" | "grease-stripped";
}
/**
 * The tag is absent, repeated, empty, has an empty value, or repeats a
 * value (required id-list tag cardinality violation).
 */
 | {
    kind: "malformed";
}
/**
 * The tag is well formed but advertises a real proposal the leaf does not,
 * omits one the leaf does, or spells a value non-canonically.
 */
 | {
    kind: "mismatch";
};
/**
 * Checks a kind 30443 event's `mls_proposals` tag against the decoded
 * KeyPackage leaf's `capabilities.proposals`.
 *
 * Values are compared as exact strings against the canonical lowercase
 * `0x%04x` spelling of each leaf id, with no parsing, so a non-canonical
 * spelling is a mismatch. An exact match (GREASE included) is what MDK
 * requires. The `grease-stripped` mode exists to accept KeyPackages from
 * older marmot-ts publishers that filtered GREASE out of the tag; because it
 * removes GREASE from both sides, a tag carrying different GREASE ids than
 * the leaf still matches in that mode (GREASE ids carry no semantics).
 *
 * Never throws — malformed input is a typed result, not an exception.
 *
 * @param event - The kind 30443 event (or any `{ tags }` shape) to read the tag from
 * @param keyPackage - The KeyPackage decoded from the same event's content
 * @returns A {@link KeyPackageProposalsTagCheck} discriminated by `kind`
 * @see refs/marmot transports/nostr.md "KeyPackage publication" — id-list
 *   tags are compared as exact strings and MUST NOT repeat values
 * @see refs/mdk crates/marmot-app/src/key_package_records.rs
 *   `require_multi_value_key_package_tag_matches`
 */
export declare function checkKeyPackageProposalsTag<T extends {
    tags: string[][];
}>(event: T, keyPackage: KeyPackage): KeyPackageProposalsTagCheck;
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
