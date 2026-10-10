/** Decoded `marmot.group.blossom.image.v1` state. */
export interface GroupBlossomImageV1 {
    /** SHA-256 of the encrypted blob (its Blossom content id), or empty when absent. */
    imageHash: Uint8Array;
    /** ChaCha20-Poly1305 content key, or empty when absent. */
    imageKey: Uint8Array;
    /** ChaCha20-Poly1305 nonce, or empty when absent. */
    imageNonce: Uint8Array;
    /** Secret key authorizing Blossom writes for this blob, or empty when absent. */
    imageUploadKey: Uint8Array;
    /** Canonical media type of the decrypted image, or `""` when absent. */
    mediaType: string;
}
/** The absent (cleared) image state. */
export declare function emptyGroupBlossomImageV1(): GroupBlossomImageV1;
/** Whether `image` carries an image (any field non-empty). */
export declare function isGroupBlossomImagePresent(image: GroupBlossomImageV1): boolean;
/**
 * Canonicalizes a media type for the group image component and its AEAD AAD:
 * drop parameters after the first `;`, trim ASCII whitespace, require exactly
 * one `/` between non-empty token `type` and `subtype` (each at most 64 bytes,
 * whole at most 128), ASCII-lowercase, and map `image/jpg` to `image/jpeg`.
 *
 * This is byte-for-byte MDK's `canonicalize_marmot_media_type`, which is what
 * White Noise applies when it validates a `0x8002` commit. It is stricter than
 * the five steps in `features/encrypted-media-v1.md` (token characters, single
 * slash, length bounds); using the looser rule here would let this library
 * accept image state that MDK members reject, forking the group.
 *
 * @throws Error if the value is not a valid media type.
 */
export declare function canonicalizeGroupImageMediaType(value: string): string;
/**
 * Encodes a {@link GroupBlossomImageV1} to component `data` bytes. A present
 * image's media type is canonicalized before encoding.
 */
export declare function encodeGroupBlossomImageV1(image: GroupBlossomImageV1): Uint8Array;
/**
 * Decodes `marmot.group.blossom.image.v1` component `data` bytes, rejecting
 * partial states and a non-canonical media type.
 */
export declare function decodeGroupBlossomImageV1(data: Uint8Array): GroupBlossomImageV1;
/** The result of {@link encryptGroupBlossomImage}. */
export interface EncryptedGroupBlossomImage {
    /** The opaque blob to upload; its SHA-256 is `image.imageHash`. */
    encryptedBlob: Uint8Array;
    /** The component state to commit. */
    image: GroupBlossomImageV1;
}
/**
 * Encrypts a group image for `marmot.group.blossom.image.v1` with a fresh
 * random key, nonce and upload key. Upload `encryptedBlob` to a Blossom server
 * under `image.imageHash` (signing the upload authorization with
 * `image.imageUploadKey`), then commit `image`.
 */
export declare function encryptGroupBlossomImage(plaintext: Uint8Array, mediaType: string): EncryptedGroupBlossomImage;
/**
 * Verifies a fetched blob against `image.imageHash` and decrypts it.
 *
 * @throws Error if the image is absent, the hash does not match, or the AEAD
 *   check fails. Per the spec this is an application-level fetch failure; it
 *   never invalidates the component state.
 */
export declare function decryptGroupBlossomImage(encryptedBlob: Uint8Array, image: GroupBlossomImageV1): Uint8Array;
