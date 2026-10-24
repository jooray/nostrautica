import type { CiphersuiteImpl, ClientState } from "../../vendor/ts-mls/index.js";
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
    assertOpen?: () => void;
    /**
     * The still-retained canonical states, used to decrypt
     * media from an epoch older than the current tip. Optional — when omitted,
     * decryption uses only the current epoch's key. See
     * {@link GroupMediaService.decryptMedia}.
     */
    getRetainedStates?: () => Iterable<ClientState>;
};
/**
 * Source-bound v2 encryption and verified plaintext cache writes.
 * Retained state is bounded by the existing session rollback policy.
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
        expectedParent: string;
    }>;
    /**
     * Decrypt using the sourceParent supplied on the accepted application-message
     * result. Omission selects the current state only. Missing retained material
     * makes the attachment unavailable; it does not invalidate its message.
     * Cache contents never bypass cryptographic or metadata validation.
     */
    decryptMedia(encrypted: Uint8Array, attachment: MediaAttachment, sourceParent?: string): Promise<StoredMedia>;
}
