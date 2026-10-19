import type { ClientState, GroupInfo } from "../vendor/ts-mls/index.js";
import { type GroupBlossomImagePresent } from "./components/blossom-image.js";
declare const groupImageSnapshotIdentityBrand: unique symbol;
/** Opaque fingerprint of every canonical metadata field, including both keys. */
export type GroupImageSnapshotIdentity = string & {
    readonly [groupImageSnapshotIdentityBrand]: true;
};
/** Canonical render selection, independent of image download/loading status. */
export type GroupImageSource = {
    kind: "none";
} | {
    kind: "url";
    url: string;
    dim?: string;
    thumbhash?: string;
} | {
    kind: "blossom";
    metadata: GroupBlossomImagePresent;
    snapshotIdentity: GroupImageSnapshotIdentity;
};
/** Hash the complete canonical encoding without exposing secret material in an identity. */
export declare function getGroupImageSnapshotIdentity(metadata: GroupBlossomImagePresent): GroupImageSnapshotIdentity;
/**
 * Read only the authenticated canonical GroupContext. Does no I/O and does not
 * claim that any image bytes are loaded. A URL wins without inspecting Blossom.
 */
export declare function getGroupImageSource(state: ClientState | GroupInfo): GroupImageSource;
/** Ciphertext (including its tag) plus complete owned MLS metadata. */
export interface EncryptedGroupImage {
    ciphertext: Uint8Array;
    metadata: GroupBlossomImagePresent;
}
/** Integrity failures disclose no plaintext and can be mapped to asset unavailability. */
export declare class GroupImageIntegrityError extends Error {
    readonly reason: "hash-mismatch" | "aead-failure";
    constructor(reason: "hash-mismatch" | "aead-failure");
}
/** Exact image AAD; see `app-components/group-blossom-image-v1.md` (Image bytes). */
export declare function buildGroupImageAad(mediaType: string): Uint8Array;
/** Encrypt with independent fresh content key, nonce and Nostr upload credential. */
export declare function encryptGroupImage(plaintext: Uint8Array, declaredMediaType: string): EncryptedGroupImage;
/** Verify the complete ciphertext hash before constructing or invoking AEAD. */
export declare function decryptGroupImage(ciphertext: Uint8Array, metadata: GroupBlossomImagePresent): Uint8Array;
export {};
