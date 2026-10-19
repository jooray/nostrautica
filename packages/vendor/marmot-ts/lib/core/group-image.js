/** @module @category Core - Group Images */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, randomBytes } from "@noble/hashes/utils.js";
import { equalBytes } from "@noble/ciphers/utils.js";
import { generateSecretKey } from "applesauce-core/helpers/keys";
import { canonicalizeGroupImageMediaType, decodeGroupBlossomImage, encodeGroupBlossomImage, } from "./components/blossom-image.js";
import { getComponentData, getGroupAvatarUrl, } from "./components/dictionary.js";
import { GROUP_BLOSSOM_IMAGE_COMPONENT_ID } from "./components/ids.js";
/** Hash the complete canonical encoding without exposing secret material in an identity. */
export function getGroupImageSnapshotIdentity(metadata) {
    return bytesToHex(sha256(concatBytes(new TextEncoder().encode("marmot-group-image-snapshot-v1\0"), encodeGroupBlossomImage(metadata))));
}
/**
 * Read only the authenticated canonical GroupContext. Does no I/O and does not
 * claim that any image bytes are loaded. A URL wins without inspecting Blossom.
 */
export function getGroupImageSource(state) {
    const extensions = state.groupContext.extensions;
    const avatar = getGroupAvatarUrl(extensions);
    if (avatar?.url)
        return { kind: "url", ...avatar };
    const data = getComponentData(extensions, GROUP_BLOSSOM_IMAGE_COMPONENT_ID);
    if (!data)
        return { kind: "none" };
    const metadata = decodeGroupBlossomImage(data);
    if (metadata.kind === "empty")
        return { kind: "none" };
    return {
        kind: "blossom",
        metadata,
        snapshotIdentity: getGroupImageSnapshotIdentity(metadata),
    };
}
/** Integrity failures disclose no plaintext and can be mapped to asset unavailability. */
export class GroupImageIntegrityError extends Error {
    reason;
    constructor(reason) {
        super(`group image ${reason}`);
        this.reason = reason;
        this.name = "GroupImageIntegrityError";
    }
}
/** Exact image AAD; see `app-components/group-blossom-image-v1.md` (Image bytes). */
export function buildGroupImageAad(mediaType) {
    return concatBytes(new TextEncoder().encode("marmot-group-image-v1"), Uint8Array.of(0), new TextEncoder().encode(canonicalizeGroupImageMediaType(mediaType)));
}
/** Encrypt with independent fresh content key, nonce and Nostr upload credential. */
export function encryptGroupImage(plaintext, declaredMediaType) {
    const mediaType = canonicalizeGroupImageMediaType(declaredMediaType);
    // Module-mocked internal randomness seam; no caller-supplied key/nonce option.
    const imageKey = randomBytes(32).slice();
    const imageNonce = randomBytes(12).slice();
    const imageUploadKey = generateSecretKey().slice();
    const ciphertext = chacha20poly1305(imageKey, imageNonce, buildGroupImageAad(mediaType))
        .encrypt(plaintext.slice())
        .slice();
    return {
        ciphertext,
        metadata: {
            kind: "present",
            imageHash: sha256(ciphertext).slice(),
            imageKey,
            imageNonce,
            imageUploadKey,
            mediaType,
        },
    };
}
/** Verify the complete ciphertext hash before constructing or invoking AEAD. */
export function decryptGroupImage(ciphertext, metadata) {
    const image = decodeGroupBlossomImage(encodeGroupBlossomImage(metadata));
    if (image.kind !== "present")
        throw new Error("group image is empty");
    const ownedCiphertext = ciphertext.slice();
    if (!equalBytes(sha256(ownedCiphertext), image.imageHash)) {
        throw new GroupImageIntegrityError("hash-mismatch");
    }
    try {
        return chacha20poly1305(image.imageKey, image.imageNonce, buildGroupImageAad(image.mediaType))
            .decrypt(ownedCiphertext)
            .slice();
    }
    catch {
        throw new GroupImageIntegrityError("aead-failure");
    }
}
