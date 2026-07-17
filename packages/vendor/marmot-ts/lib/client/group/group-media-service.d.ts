import type { CiphersuiteImpl, ClientState } from "ts-mls";
import { type MediaAttachment } from "../../core/media.js";
import type { BaseGroupMedia, StoredMedia } from "./marmot-group.js";
export type EncryptMediaMetadata = {
    filename: string;
    /** MIME type; falls back to `blob.type` when omitted. */
    type?: string;
    /** Optional `<width>x<height>` render hint. */
    dim?: string;
    /** Optional thumbhash preview value. */
    thumbhash?: string;
};
export type GroupMediaServiceOptions<TMedia extends BaseGroupMedia | undefined = undefined> = {
    media: TMedia;
    getState: () => ClientState;
    getCiphersuite: () => CiphersuiteImpl;
};
/**
 * Optional group-scoped encrypted-media helper and plaintext cache adapter.
 *
 * Note: key derivation here uses the group's CURRENT `ClientState`. On send
 * that is correct (the source epoch is the current epoch). On receive of media
 * from an older epoch, the caller must supply the source-epoch state instead;
 * source-epoch media-secret retention is tracked separately (see
 * `features/encrypted-media.md` — Key Derivation).
 */
export declare class GroupMediaService<TMedia extends BaseGroupMedia | undefined = undefined> {
    #private;
    readonly media: TMedia;
    constructor(options: GroupMediaServiceOptions<TMedia>);
    /**
     * Encrypts a blob for sharing in a group message. The returned attachment has
     * its hashes, nonce, media type, and filename set but no locators — the
     * caller uploads `encrypted` to a blob store, adds a {@link MediaAttachment}
     * locator, then serializes it with `encodeMediaImetaTag`.
     */
    encryptMedia(blob: Blob, metadata: EncryptMediaMetadata): Promise<{
        encrypted: Uint8Array;
        attachment: MediaAttachment;
    }>;
    /**
     * Decrypts a fetched blob for a parsed attachment, verifying its ciphertext
     * and plaintext hashes, and caches the plaintext keyed by `ciphertextSha256`.
     */
    decryptMedia(encrypted: Uint8Array, attachment: MediaAttachment): Promise<StoredMedia>;
}
