/** @module @category Core - Encrypted Media */
/**
 * Canonicalizes a MIME type for use in `encrypted-media-v1` cryptographic
 * operations (key derivation and AEAD AAD).
 *
 * Sender and receiver MUST apply this identical algorithm
 * (`features/encrypted-media.md` — Media Type Canonicalization):
 *
 * 1. take the substring before the first `;`, dropping any parameters
 * 2. trim leading and trailing ASCII whitespace
 * 3. lowercase using ASCII case folding only
 * 4. reject if the result is empty or does not contain `/`
 * 5. apply the canonical alias `image/jpg` → `image/jpeg`
 *
 * Adding an alias or normalization step is a breaking media-version change.
 *
 * @param mimeType - The raw MIME type string
 * @returns The canonical MIME type
 * @throws If the canonical result is empty or has no `/`
 */
export declare function canonicalizeMimeType(mimeType: string): string;
/**
 * The shared Marmot media-type canonicalization used by `encrypted-media-v2`
 * (`foundation/canonical-encoding.md` "Media type canonicalization"; MDK
 * `canonical_media_type_v2`). Stricter than the frozen v1 algorithm
 * ({@link canonicalizeMimeType}):
 *
 * 1. take the substring before the first `;`
 * 2. trim only HTAB, LF, FF, CR and space (not VT, not Unicode whitespace)
 * 3. ASCII-lowercase
 * 4. require exactly one `/` with a non-empty type and subtype, each at most
 *    64 bytes and together at most 128 bytes
 * 5. require every type/subtype byte to be an HTTP token byte
 * 6. apply the alias `image/jpg` → `image/jpeg`
 *
 * A v2 receiver requires the stored `m` value to be byte-equal to this
 * function's output; it never repairs a non-canonical value.
 *
 * @throws If the value cannot be canonicalized
 */
export declare function canonicalizeMimeTypeV2(mimeType: string): string;
/**
 * Returns `true` iff {@link canonicalizeMimeType} accepts `value` (it is a
 * non-empty `type/subtype` string).
 *
 * @internal
 */
export declare function isValidMimeType(value: string): boolean;
/**
 * Returns true iff `value` is valid hex with the expected encoded byte length.
 *
 * @internal
 */
export declare function isValidHex(value: string, expectedBytes: number): boolean;
/**
 * Like {@link isValidHex} but case-insensitive, matching the Rust `hex` crate
 * MDK uses to validate v2 hashes and nonces.
 *
 * @internal
 */
export declare function isValidHexAnyCase(value: string, expectedBytes: number): boolean;
