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
