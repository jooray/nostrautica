/**
 * Codec for `marmot.group.encrypted-media.v1` (`0x8008`) — the group's
 * encrypted-media policy: the media format, the allowed blob locator kinds, and
 * the default blob-store endpoints.
 *
 * Wire (Marmot binary profile):
 *   opaque media_format<V>;                 // must be "encrypted-media-v1"
 *   opaque allowed_locator_kinds<V>;        // concat of opaque kind<V>
 *   opaque default_blob_endpoints<V>;       // concat of opaque endpoint<V>
 *   // each endpoint = opaque locator_kind<V> ++ opaque base_url<V>
 *
 * Locator kinds are normalized (trim, ASCII-lowercase, `[a-z0-9-]`, ≤64 bytes)
 * and deduped; endpoint URLs are validated + normalized (loopback `http`
 * allowed). At least one allowed kind and one endpoint are required.
 *
 * @see darkmatter `crates/traits/src/app_components.rs` `encode_encrypted_media_policy_v1`
 */
export declare const ENCRYPTED_MEDIA_FORMAT_V1 = "encrypted-media-v1";
export declare const BLOSSOM_LOCATOR_KIND_V1 = "blossom-v1";
export interface BlobStoreEndpointV1 {
    locatorKind: string;
    baseUrl: string;
}
export interface EncryptedMediaPolicyV1 {
    mediaFormat: string;
    allowedLocatorKinds: string[];
    defaultBlobEndpoints: BlobStoreEndpointV1[];
}
/** Builds the default Blossom-backed policy for the given endpoint base URLs. */
export declare function encryptedMediaBlossomDefault(baseUrls: string[]): EncryptedMediaPolicyV1;
/** Encodes an {@link EncryptedMediaPolicyV1} to its component `data` bytes. */
export declare function encodeEncryptedMediaPolicyV1(policy: EncryptedMediaPolicyV1): Uint8Array;
/**
 * Decodes `marmot.group.encrypted-media.v1` component `data` bytes strictly.
 *
 * Per darkmatter `decode_encrypted_media_policy_v1` and
 * `foundation/canonical-encoding.md` ("Canonical decoding"), this is a decoder
 * of signed, state-selecting Marmot bytes: it MUST reject input that is not
 * already canonical and MUST NOT trim, case-fold, normalize, deduplicate, or
 * reorder anything. Every check is a validation; a failure throws. Repairing
 * non-canonical state here (as the old producer-`normalizePolicy` reuse did)
 * forks commit acceptance against conformant implementations.
 */
export declare function decodeEncryptedMediaPolicyV1(data: Uint8Array): EncryptedMediaPolicyV1;
