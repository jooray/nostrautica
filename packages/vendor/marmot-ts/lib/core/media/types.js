/** @module @category Core - Encrypted Media */
/**
 * Media format / version string for the current encrypted-media scheme.
 *
 * Written to the `v` field of an attachment `imeta` tag and mixed into the
 * key-derivation context and AEAD associated data. New media references MUST
 * use this value; v2 parsing rejects every other media-version string (see
 * darkmatter `features/encrypted-media.md`).
 */
export const ENCRYPTED_MEDIA_VERSION = "encrypted-media-v2";
/** The initial (and only v1) locator kind. */
export const BLOSSOM_LOCATOR_KIND = "blossom-v1";
