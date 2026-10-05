import { type CiphersuiteImpl, type ClientState } from "../../vendor/ts-mls/index.js";
import { type EncryptedMediaVersion, type EncryptMediaFileResult, type MediaAttachment } from "./types.js";
/**
 * The crypto-relevant subset of a {@link MediaAttachment}. `version` selects
 * the scheme label and validation profile; when omitted it defaults to
 * `encrypted-media-v1` so pre-v2 callers keep their exact behaviour.
 */
type MediaCryptoFields = Pick<MediaAttachment, "plaintextSha256" | "mediaType" | "filename"> & {
    version?: EncryptedMediaVersion;
};
/**
 * Throws unless `filename` satisfies the version's filename profile. v2:
 * 1..255 UTF-8 bytes with no U+0000, preserved exactly. v1: non-empty after
 * trimming (MDK `validate_outbound_file_name`).
 *
 * @internal
 */
export declare function assertMediaFilename(filename: string, version: EncryptedMediaVersion): void;
/**
 * Derives the per-file encryption key for an encrypted-media attachment.
 *
 * ```
 * media_secret = MLS-Exporter("marmot", "encrypted-media", 32) at source_epoch
 * file_key     = HKDF-Expand(media_secret,
 *                  version || 0x00 || plaintext_sha256_bytes ||
 *                  0x00 || media_type || 0x00 || filename || 0x00 || "key", 32)
 * ```
 *
 * `version` is `attachment.version` (`"encrypted-media-v1"` when omitted, or
 * `"encrypted-media-v2"`). The exporter secret is the same for both versions.
 *
 * HKDF is HKDF-SHA256 with `media_secret` used directly as the PRK (Expand
 * only, no Extract). The key is deterministic for a given source epoch + file.
 *
 * The source epoch is the MLS epoch of the application message that carried the
 * attachment. The caller MUST pass the `ClientState` for that epoch: on send,
 * the current state; on receive, the retained state for the message's source
 * epoch (see `features/encrypted-media.md` — Key Derivation).
 *
 * @param clientState - The MLS `ClientState` for the attachment's source epoch
 * @param ciphersuite - The ciphersuite implementation used by the group
 * @param attachment - Provides `version`, `plaintextSha256`, `mediaType`, and
 *   `filename`
 * @returns 32-byte ChaCha20-Poly1305 encryption key
 */
export declare function deriveMediaEncryptionKey(clientState: ClientState, ciphersuite: CiphersuiteImpl, attachment: MediaCryptoFields): Promise<Uint8Array>;
/**
 * Derives the per-file key from an already-exported 32-byte media secret
 * (`MLS-Exporter("marmot", "encrypted-media", 32)` at the source epoch). This is
 * the HKDF-Expand half of {@link deriveMediaEncryptionKey}, exposed so callers
 * that cache media secrets per epoch (as MDK does) can derive keys without the
 * `ClientState`, and so the derivation can be checked against fixed vectors.
 *
 * @param mediaSecret - 32-byte media exporter secret for the source epoch
 * @param attachment - Provides `version`, `plaintextSha256`, `mediaType`, `filename`
 */
export declare function deriveMediaFileKeyFromSecret(mediaSecret: Uint8Array, attachment: MediaCryptoFields): Uint8Array;
/**
 * Exports the group media secret `MLS-Exporter("marmot", "encrypted-media",
 * 32)` for `clientState`'s epoch. Key material: never log or transmit it.
 */
export declare function exportMediaSecret(clientState: ClientState, ciphersuite: CiphersuiteImpl): Promise<Uint8Array>;
/**
 * Encrypts a media file for an encrypted-media attachment.
 *
 * Uses ChaCha20-Poly1305 AEAD with a fresh random 12-byte nonce. The AAD binds
 * the format version, plaintext hash, canonical MIME type, and filename.
 * Computes `ciphertextSha256 = SHA256(encrypted)` and returns a
 * {@link MediaAttachment} with `locators` left empty for the caller to fill
 * after upload.
 *
 * @param file - The plaintext file bytes to encrypt
 * @param fileKey - 32-byte key from {@link deriveMediaEncryptionKey}, derived
 *   for the same `version`, hash, media type and filename
 * @param fields - Provides `plaintextSha256`, `mediaType`, `filename`, and
 *   `version` (default `encrypted-media-v1`); optional `dim`/`thumbhash` are
 *   carried through onto the result. For v2 the media type is canonicalized
 *   with the v2 algorithm before use and the filename profile is enforced.
 * @returns Encrypted blob and a populated {@link MediaAttachment}
 */
export declare function encryptMediaFile(file: Uint8Array, fileKey: Uint8Array, fields: MediaCryptoFields & Pick<Partial<MediaAttachment>, "dim" | "thumbhash">): EncryptMediaFileResult;
/**
 * Decrypts a fetched encrypted-media blob (v1 or v2, per `attachment.version`).
 *
 * Performs the receive-side integrity checks in order
 * (`features/encrypted-media.md` — Validation):
 *
 * 1. the fetched bytes match `ciphertextSha256`
 * 2. ChaCha20-Poly1305 authentication succeeds
 * 3. the decrypted bytes match `plaintextSha256`
 *
 * @param encrypted - The encrypted blob downloaded from a blob store
 * @param fileKey - 32-byte key from {@link deriveMediaEncryptionKey}
 * @param attachment - The parsed attachment from the message's `imeta` tag
 * @returns The decrypted file bytes
 * @throws If any integrity check fails or required fields are missing
 */
export declare function decryptMediaFile(encrypted: Uint8Array, fileKey: Uint8Array, attachment: MediaAttachment): Uint8Array;
/**
 * Decrypts a fetched encrypted-media blob, trying each candidate key in
 * order until one authenticates the ciphertext.
 *
 * The media file key is derived from the source-epoch media exporter secret
 * (`features/encrypted-media.md` — Key Derivation), but the source epoch is not
 * carried in the `imeta` tag. Rather than thread the source epoch through every
 * caller, the receiver supplies one key per still-retained epoch (current epoch
 * first) and relies on the AEAD tag to identify the right one. The ciphertext
 * hash is verified once; only the cheap AEAD open is retried per key.
 *
 * @param encrypted - The encrypted blob downloaded from a blob store
 * @param fileKeys - Candidate keys from {@link deriveMediaEncryptionKey}, one
 *   per retained epoch; tried in order. MUST be non-empty.
 * @param attachment - The parsed attachment from the message's `imeta` tag
 * @returns The decrypted file bytes from the first key that authenticates
 * @throws If no candidate key authenticates the ciphertext, or a check fails
 */
export declare function decryptMediaFileWithKeys(encrypted: Uint8Array, fileKeys: Uint8Array[], attachment: MediaAttachment): Uint8Array;
export {};
