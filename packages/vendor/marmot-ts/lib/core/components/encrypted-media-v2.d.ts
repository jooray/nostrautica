/**
 * Codec for `marmot.group.encrypted-media.v2` (`0x800b`) — the group's
 * encrypted-media policy: the media format, the allowed blob locator kinds, and
 * the default blob-store endpoints.
 *
 * Wire (Marmot binary profile):
 *   opaque media_format<V>;                 // must be "encrypted-media-v2"
 *   opaque allowed_locator_kinds<V>;        // concat of opaque kind<V>
 *   opaque default_blob_endpoints<V>;       // concat of opaque endpoint<V>
 *   // each endpoint = opaque locator_kind<V> ++ opaque base_url<V>
 *
 * Locator kinds are normalized (trim, ASCII-lowercase, `[a-z0-9-]`, ≤64 bytes)
 * and deduped; endpoint URLs are normalized http/https, without credentials, queries
 * or fragments. Contact permission is a separate local policy. At least one allowed kind and one endpoint are required.
 *
 * @see darkmatter `crates/traits/src/app_components.rs` `encode_encrypted_media_policy_v1`
 */
export declare const ENCRYPTED_MEDIA_FORMAT_V2 = "encrypted-media-v2";
export declare const BLOSSOM_LOCATOR_KIND_V2 = "blossom-v1";
export interface BlobStoreEndpointV2 {
    locatorKind: string;
    baseUrl: string;
}
export interface EncryptedMediaPolicyV2 {
    mediaFormat: string;
    allowedLocatorKinds: string[];
    defaultBlobEndpoints: BlobStoreEndpointV2[];
}
/** Builds the default Blossom-backed policy for the given endpoint base URLs. */
export declare function encryptedMediaBlossomDefaultV2(baseUrls: string[]): EncryptedMediaPolicyV2;
/** Encodes an {@link EncryptedMediaPolicyV2} to its component `data` bytes. */
export declare function encodeEncryptedMediaPolicyV2(policy: EncryptedMediaPolicyV2): Uint8Array;
/**
 * Decodes `marmot.group.encrypted-media.v2` component `data` bytes strictly.
 *
 * Per darkmatter `decode_encrypted_media_policy_v1` and
 * `foundation/canonical-encoding.md` ("Canonical decoding"), this is a decoder
 * of signed, state-selecting Marmot bytes: it MUST reject input that is not
 * already canonical and MUST NOT trim, case-fold, normalize, deduplicate, or
 * reorder anything. Every check is a validation; a failure throws. Repairing
 * non-canonical state here (as the old producer-`normalizePolicy` reuse did)
 * forks commit acceptance against conformant implementations.
 */
export declare function decodeEncryptedMediaPolicyV2(data: Uint8Array): EncryptedMediaPolicyV2;
export { encryptedMediaBlossomDefaultV2 as encryptedMediaBlossomDefault };
