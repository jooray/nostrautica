/** @module @category Client - Group Media */
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalizeMimeType, decryptMediaFile, deriveMediaEncryptionKey, encryptMediaFile, } from "../../core/media.js";
/**
 * Optional group-scoped encrypted-media helper and plaintext cache adapter.
 *
 * Note: key derivation here uses the group's CURRENT `ClientState`. On send
 * that is correct (the source epoch is the current epoch). On receive of media
 * from an older epoch, the caller must supply the source-epoch state instead;
 * source-epoch media-secret retention is tracked separately (see
 * `features/encrypted-media.md` — Key Derivation).
 */
export class GroupMediaService {
    media;
    #getState;
    #getCiphersuite;
    #decryptingMedia = new Map();
    constructor(options) {
        this.media = options.media;
        this.#getState = options.getState;
        this.#getCiphersuite = options.getCiphersuite;
    }
    /**
     * Encrypts a blob for sharing in a group message. The returned attachment has
     * its hashes, nonce, media type, and filename set but no locators — the
     * caller uploads `encrypted` to a blob store, adds a {@link MediaAttachment}
     * locator, then serializes it with `encodeMediaImetaTag`.
     */
    async encryptMedia(blob, metadata) {
        const mimeType = metadata.type ?? blob.type;
        if (!mimeType) {
            throw new Error("encryptMedia: MIME type is required — pass metadata.type or ensure blob.type is set");
        }
        const plaintext = new Uint8Array(await blob.arrayBuffer());
        const fields = {
            plaintextSha256: bytesToHex(sha256(plaintext)),
            mediaType: canonicalizeMimeType(mimeType),
            filename: metadata.filename,
            ...(metadata.dim !== undefined ? { dim: metadata.dim } : {}),
            ...(metadata.thumbhash !== undefined
                ? { thumbhash: metadata.thumbhash }
                : {}),
        };
        const fileKey = await deriveMediaEncryptionKey(this.#getState(), this.#getCiphersuite(), fields);
        return encryptMediaFile(plaintext, fileKey, fields);
    }
    /**
     * Decrypts a fetched blob for a parsed attachment, verifying its ciphertext
     * and plaintext hashes, and caches the plaintext keyed by `ciphertextSha256`.
     */
    async decryptMedia(encrypted, attachment) {
        const key = attachment.ciphertextSha256;
        if (!key) {
            throw new Error("decryptMedia: attachment.ciphertextSha256 is required");
        }
        const cached = await this.media?.getMedia(key);
        if (cached)
            return cached;
        const inFlight = this.#decryptingMedia.get(key);
        if (inFlight)
            return inFlight;
        const decryptPromise = (async () => {
            const fileKey = await deriveMediaEncryptionKey(this.#getState(), this.#getCiphersuite(), attachment);
            const plaintext = decryptMediaFile(encrypted, fileKey, attachment);
            await this.media?.addMedia(key, {
                data: plaintext,
                attachment,
            });
            return { data: plaintext, attachment };
        })();
        this.#decryptingMedia.set(key, decryptPromise);
        try {
            return await decryptPromise;
        }
        finally {
            this.#decryptingMedia.delete(key);
        }
    }
}
//# sourceMappingURL=group-media-service.js.map