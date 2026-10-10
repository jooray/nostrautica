import type { EventSigner } from "applesauce-core/factories";
import type { CiphersuiteImpl, ClientState } from "../../vendor/ts-mls/index.js";
import { type EncryptedMediaPolicy, type EncryptedMediaVersion, type MediaAttachment } from "../../core/media.js";
import { type FetchLike } from "./blossom.js";
import type { BaseGroupMedia, StoredMedia } from "./marmot-group.js";
/**
 * Selects the media format for new references in a group from its
 * GroupContext, like MDK `encrypted_media_for_group`: `encrypted-media-v2` when
 * the group carries or requires `marmot.group.encrypted-media.v2` (`0x800b`),
 * `encrypted-media-v1` when it carries or requires only the frozen `0x8008`,
 * and `encrypted-media-v2` otherwise — every group this library joins is a
 * current-profile group, and current-profile senders create only v2
 * references (`features/encrypted-media.md` — Migration).
 */
export declare function selectGroupMediaVersion(state: ClientState): EncryptedMediaVersion;
/**
 * The group's media policy for `version` (`0x800b` for v2, `0x8008` for v1),
 * or `undefined` when the group carries no such component.
 */
export declare function getGroupMediaPolicy(state: ClientState, version?: EncryptedMediaVersion): EncryptedMediaPolicy | undefined;
export type EncryptMediaMetadata = {
    filename: string;
    /** MIME type; falls back to `blob.type` when omitted. */
    type?: string;
    /** Optional `<width>x<height>` render hint. */
    dim?: string;
    /** Optional thumbhash preview value. */
    thumbhash?: string;
    /**
     * Media format to produce. Defaults to the group's format
     * ({@link selectGroupMediaVersion}); set it only to interoperate with a
     * peer that needs a specific version.
     */
    version?: EncryptedMediaVersion;
};
export type UploadMediaOptions = {
    /**
     * Blossom servers to try in order. Defaults to the group policy's
     * `blossom-v1` `default_blob_endpoints`.
     */
    servers?: string[];
};
export type DownloadMediaOptions = {
    /** Allow cleartext-`http` loopback fetch candidates (local dev/test only). */
    allowLoopbackHttp?: boolean;
};
export type GroupMediaServiceOptions<TMedia extends BaseGroupMedia | undefined = undefined> = {
    media: TMedia;
    getState: () => ClientState;
    getCiphersuite: () => CiphersuiteImpl;
    /**
     * The still-retained canonical states (newest epoch first), used to decrypt
     * media from an epoch older than the current tip. Optional — when omitted,
     * decryption uses only the current epoch's key. See
     * {@link GroupMediaService.decryptMedia}.
     */
    getRetainedStates?: () => Iterable<ClientState>;
    /** Signs Blossom upload authorizations for {@link GroupMediaService.uploadMedia}. */
    getSigner?: () => EventSigner;
    /** HTTP client for upload/download; defaults to the global `fetch`. */
    fetch?: FetchLike;
};
/**
 * Optional group-scoped encrypted-media helper and plaintext cache adapter.
 *
 * On send, the media file key is derived from the group's CURRENT `ClientState`
 * — the source epoch is the current epoch. On receive, the source epoch is the
 * MLS epoch of the message that carried the attachment, which is not encoded in
 * the `imeta` tag (`features/encrypted-media.md` — Key Derivation). Rather than
 * thread that epoch through every caller, {@link decryptMedia} derives one
 * candidate key per still-retained epoch and lets the AEAD tag pick the right
 * one, so media sent before the local tip advanced still decrypts. Media from
 * an epoch already pruned past the rollback horizon cannot be decrypted.
 */
export declare class GroupMediaService<TMedia extends BaseGroupMedia | undefined = undefined> {
    #private;
    readonly media: TMedia;
    constructor(options: GroupMediaServiceOptions<TMedia>);
    /** The media format new references in this group use. */
    get mediaVersion(): EncryptedMediaVersion;
    /** The group's current media policy for {@link mediaVersion}, if any. */
    get mediaPolicy(): EncryptedMediaPolicy | undefined;
    /**
     * Encrypts a blob for sharing in a group message, in the group's media
     * format ({@link mediaVersion}, normally `encrypted-media-v2`). The returned
     * attachment has its hashes, nonce, media type, and filename set but no
     * locators — the caller uploads `encrypted` to a blob store, adds a
     * {@link MediaAttachment} locator, then serializes it with
     * `encodeMediaImetaTag`. {@link uploadMedia} does both steps.
     */
    encryptMedia(blob: Blob, metadata: EncryptMediaMetadata): Promise<{
        encrypted: Uint8Array;
        attachment: MediaAttachment;
    }>;
    /**
     * Encrypts `blob` and uploads the ciphertext to Blossom (MDK
     * `upload_encrypted_media`): tries `opts.servers`, or else the group
     * policy's `blossom-v1` default endpoints, in order. Returns the attachment
     * with one `blossom-v1` locator, ready for `encodeMediaImetaTag`.
     *
     * The key is bound to the CURRENT epoch, so send the carrying message before
     * the group advances; a reference sent from a later epoch will not decrypt.
     *
     * @throws When no signer is configured, no endpoint is available, the
     *   group policy does not allow `blossom-v1`, or every upload fails.
     */
    uploadMedia(blob: Blob, metadata: EncryptMediaMetadata, opts?: UploadMediaOptions): Promise<{
        encrypted: Uint8Array;
        attachment: MediaAttachment;
    }>;
    /**
     * Fetches, verifies and decrypts a parsed attachment (MDK
     * `download_encrypted_media`). Candidates are the attachment's fetchable
     * locators followed by the group policy's fallback endpoints
     * (`resolveMediaFetchUrls`); the first body matching `ciphertextSha256` is
     * decrypted with {@link decryptMedia}. Cached plaintext is returned without
     * a network request.
     */
    downloadMedia(attachment: MediaAttachment, opts?: DownloadMediaOptions): Promise<StoredMedia>;
    /**
     * Decrypts a fetched blob for a parsed attachment, verifying its ciphertext
     * and plaintext hashes, and caches the plaintext keyed by `ciphertextSha256`.
     *
     * The media file key is bound to the message's source-epoch media exporter
     * secret, which is not carried in the `imeta` tag. This derives one candidate
     * key per still-retained epoch (current epoch first) and lets the AEAD tag
     * select the right one, so media sent before the local tip advanced still
     * decrypts. Media from an epoch already pruned past the rollback horizon
     * cannot be decrypted.
     */
    decryptMedia(encrypted: Uint8Array, attachment: MediaAttachment): Promise<StoredMedia>;
}
