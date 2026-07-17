import { type CiphersuiteImpl, type ClientState } from "ts-mls";
import { type EncryptMediaFileResult, type MediaAttachment } from "./types.js";
/** The crypto-relevant subset of a {@link MediaAttachment}. */
type MediaCryptoFields = Pick<MediaAttachment, "plaintextSha256" | "mediaType" | "filename">;
/**
 * Derives the per-file encryption key for an `encrypted-media-v1` attachment.
 *
 * ```
 * media_secret = MLS-Exporter("marmot", "encrypted-media", 32) at source_epoch
 * file_key     = HKDF-Expand(media_secret,
 *                  "encrypted-media-v1" || 0x00 || plaintext_sha256_bytes ||
 *                  0x00 || media_type || 0x00 || filename || 0x00 || "key", 32)
 * ```
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
 * @param attachment - Provides `plaintextSha256`, `mediaType`, and `filename`
 * @returns 32-byte ChaCha20-Poly1305 encryption key
 */
export declare function deriveMediaEncryptionKey(clientState: ClientState, ciphersuite: CiphersuiteImpl, attachment: MediaCryptoFields): Promise<Uint8Array>;
/**
 * Encrypts a media file for an `encrypted-media-v1` attachment.
 *
 * Uses ChaCha20-Poly1305 AEAD with a random 12-byte nonce. The AAD binds the
 * scheme version, plaintext hash, canonical MIME type, and filename. Computes
 * `ciphertextSha256 = SHA256(encrypted)` and returns a {@link MediaAttachment}
 * with `locators` left empty for the caller to fill after upload.
 *
 * @param file - The plaintext file bytes to encrypt
 * @param fileKey - 32-byte key from {@link deriveMediaEncryptionKey}
 * @param fields - Provides `plaintextSha256`, `mediaType`, and `filename`;
 *   optional `dim`/`thumbhash` are carried through onto the result
 * @returns Encrypted blob and a populated {@link MediaAttachment}
 */
export declare function encryptMediaFile(file: Uint8Array, fileKey: Uint8Array, fields: MediaCryptoFields & Pick<Partial<MediaAttachment>, "dim" | "thumbhash">): EncryptMediaFileResult;
/**
 * Decrypts a fetched `encrypted-media-v1` blob.
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
export {};
