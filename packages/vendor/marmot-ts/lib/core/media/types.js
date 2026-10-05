/** @module @category Core - Encrypted Media */
/**
 * The frozen legacy `encrypted-media-v1` format label
 * (`features/encrypted-media-v1.md`). Used by groups that carry the
 * `marmot.group.encrypted-media.v1` (`0x8008`) policy.
 */
export const ENCRYPTED_MEDIA_VERSION_V1 = "encrypted-media-v1";
/**
 * The current `encrypted-media-v2` format label (`features/encrypted-media.md`).
 * Used by groups that carry the `marmot.group.encrypted-media.v2` (`0x800b`)
 * policy, which is every current-profile group MDK creates.
 */
export const ENCRYPTED_MEDIA_VERSION_V2 = "encrypted-media-v2";
/**
 * Legacy name for {@link ENCRYPTED_MEDIA_VERSION_V1}. It stays the v1 label,
 * like MDK's `ENCRYPTED_MEDIA_VERSION`: a group's media version is selected by
 * its encrypted-media component, not by this constant.
 */
export const ENCRYPTED_MEDIA_VERSION = ENCRYPTED_MEDIA_VERSION_V1;
/** Returns `value` as an {@link EncryptedMediaVersion}, or `undefined`. */
export function parseEncryptedMediaVersion(value) {
    return value === ENCRYPTED_MEDIA_VERSION_V1 ||
        value === ENCRYPTED_MEDIA_VERSION_V2
        ? value
        : undefined;
}
/** The initial locator kind, shared by v1 and v2. */
export const BLOSSOM_LOCATOR_KIND = "blossom-v1";
