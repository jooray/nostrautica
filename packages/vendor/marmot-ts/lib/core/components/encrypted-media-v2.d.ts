/**
 * Codec for `marmot.group.encrypted-media.v2` (`0x800b`) — the current group
 * encrypted-media policy: the fixed media format, the allowed blob locator
 * kinds, and the ordered default blob-store endpoints.
 *
 * Wire (Marmot binary profile), identical in shape to v1 but under its own
 * component id and format constant:
 *
 * ```text
 * struct { opaque locator_kind<V>; } MediaLocatorKindV2;
 * struct { opaque locator_kind<V>; opaque base_url<1..2048>; } BlobStoreEndpointV2;
 * struct {
 *   opaque              media_format<V>;            // "encrypted-media-v2"
 *   MediaLocatorKindV2  allowed_locator_kinds<V>;
 *   BlobStoreEndpointV2 default_blob_endpoints<V>;
 * } EncryptedMediaPolicyV2;
 * ```
 *
 * Differences from v1 that matter for interop:
 * - endpoint URLs may be `http` or `https` with any host. Whether a client
 *   actually contacts an endpoint is local destination policy, not component
 *   validity, so loopback/private hosts are NOT rejected here.
 * - endpoint URLs with a query string are invalid (v1 accepts them).
 * - both lists keep the producer's order; they are not sorted.
 *
 * @see refs/marmot/app-components/group-encrypted-media-v2.md
 * @see refs/mdk/crates/traits/src/app_components/encrypted_media_v2.rs
 */
export declare const ENCRYPTED_MEDIA_FORMAT_V2 = "encrypted-media-v2";
/**
 * Built-in encrypted-media Blossom endpoints for new groups, in upload
 * fallback order — the same list MDK uses (`DEFAULT_BLOSSOM_SERVER_URLS` in
 * `marmot-app/src/media/mod.rs`). Each accepts opaque
 * `application/octet-stream` blobs, which encrypted media requires.
 */
export declare const DEFAULT_ENCRYPTED_MEDIA_BLOB_ENDPOINTS: readonly string[];
export interface BlobStoreEndpointV2 {
    locatorKind: string;
    baseUrl: string;
}
export interface EncryptedMediaPolicyV2 {
    mediaFormat: string;
    allowedLocatorKinds: string[];
    defaultBlobEndpoints: BlobStoreEndpointV2[];
}
/**
 * Producer-side WHATWG parse-and-serialize normalization for a v2 blob
 * endpoint base URL. Accepts `http` and `https`; rejects credentials, a
 * missing host, a query, or a fragment. Reachability and permission to contact
 * the endpoint are deliberately NOT validity rules (MDK
 * `validate_and_normalize_blob_endpoint_url_v2`).
 *
 * @returns The normalized URL (WHATWG serialization keeps a trailing `/`).
 */
export declare function validateAndNormalizeBlobEndpointUrlV2(raw: string): string;
/**
 * Builds a validated {@link EncryptedMediaPolicyV2}: trims the format,
 * normalizes and de-duplicates locator kinds and endpoints (keeping first
 * occurrence order), and validates every bound. Throws on invalid input.
 */
export declare function createEncryptedMediaPolicyV2(policy: EncryptedMediaPolicyV2): EncryptedMediaPolicyV2;
/**
 * Builds the default Blossom-backed v2 policy for the given endpoint base URLs
 * (MDK `EncryptedMediaPolicyV2::blossom_default`). Endpoint order is the
 * upload/fetch fallback priority and is preserved.
 */
export declare function encryptedMediaV2BlossomDefault(baseUrls: string[]): EncryptedMediaPolicyV2;
/** Encodes an {@link EncryptedMediaPolicyV2} to its component `data` bytes. */
export declare function encodeEncryptedMediaPolicyV2(policy: EncryptedMediaPolicyV2): Uint8Array;
/**
 * Strictly decodes `marmot.group.encrypted-media.v2` component `data` bytes.
 *
 * A decoder of signed, state-selecting bytes: it rejects anything that is not
 * already canonical and never trims, case-folds, normalizes, de-duplicates or
 * reorders (`foundation/canonical-encoding.md` "Canonical decoding"; MDK
 * `decode_encrypted_media_policy_v2`). v1 bytes are rejected because their
 * format constant differs.
 */
export declare function decodeEncryptedMediaPolicyV2(data: Uint8Array): EncryptedMediaPolicyV2;
