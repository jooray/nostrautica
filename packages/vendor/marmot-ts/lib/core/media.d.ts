/** @module @category Core - Encrypted Media */
export { ENCRYPTED_MEDIA_VERSION, BLOSSOM_LOCATOR_KIND, type MediaAttachment, type MediaLocator, type EncryptMediaFileResult, } from "./media/types.js";
export { canonicalizeMimeType } from "./media/canonical.js";
export { deriveMediaEncryptionKey, encryptMediaFile, decryptMediaFile, } from "./media/crypto.js";
export { encodeMediaImetaTag, parseMediaImetaTag, getMediaAttachments, } from "./media/imeta.js";
export { SUPPORTED_LOCATOR_KINDS, selectFetchableLocators, buildFallbackFetchUrls, resolveMediaFetchUrls, type FetchableLocatorOptions, } from "./media/locator.js";
