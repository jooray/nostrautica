import type { NostrEvent } from "applesauce-core/helpers/event";
import { type Hash, type KeyPackage } from "../vendor/ts-mls/index.js";
/** Thrown when a kind-30443 event's tags do not describe its KeyPackage. */
export declare class KeyPackageEventMetadataError extends Error {
    constructor(message: string);
}
/**
 * Checks that a kind-30443 KeyPackage event's tags describe the KeyPackage it
 * carries, as `transports/nostr.md` and `foundation/key-packages.md` require
 * before a KeyPackage is used ("required capability tags are missing or
 * incompatible", "the KeyPackageRef hint ... does not match").
 *
 * Mirrors MDK's `key_package_from_borrowed_record`
 * (`marmot-app/src/key_package_records.rs`), so marmot-ts rejects the same
 * events White Noise rejects:
 *
 * - `d` and `i` are single non-empty tags and `mls_protocol_version` is `1.0`;
 * - `mls_ciphersuite`, `mls_extensions`, `mls_proposals` and `app_components`
 *   each appear exactly once, non-empty, without duplicate values;
 * - `mls_ciphersuite` is the KeyPackage's cipher suite;
 * - `mls_extensions` equals the LeafNode's extension capabilities with GREASE
 *   ignored on both sides; `mls_proposals` equals the leaf's proposals exactly
 *   (GREASE included) or with GREASE stripped from both sides, compared as sets
 *   of `0x%04x`;
 * - `app_components` equals the LeafNode's advertised private-use
 *   (`>= 0x8000`) app components and includes `0x8009`;
 * - `i` is the KeyPackageRef computed with `hash` (the cipher suite's hash).
 *
 * @throws {KeyPackageEventMetadataError} on the first mismatch.
 */
export declare function validateKeyPackageEventMetadata(event: NostrEvent, keyPackage: KeyPackage, hash: Hash): Promise<void>;
