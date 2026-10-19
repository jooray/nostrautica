/** @module @category Core - App Components */
import { BinaryReader, BinaryWriter, encodeUtf8 } from "../binary.js";
/** Image-specific MIME normalization; does not change message-media semantics. */
export function canonicalizeGroupImageMediaType(value) {
    // MDK's strict image interpretation of the frozen media algorithm. Only these
    // five ASCII whitespace bytes are stripped; JS trim() accepts more bytes.
    const mime = value
        .split(";", 1)[0]
        .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
    const parts = mime.split("/");
    if (parts.length !== 2)
        throw new Error("group image media type must contain exactly one slash");
    if (!parts[0] || !parts[1])
        throw new Error("group image media type and subtype must be non-empty");
    if (parts[0].length > 64 || parts[1].length > 64 || mime.length > 128) {
        throw new Error("group image media type exceeds Marmot length bounds");
    }
    const token = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
    if (!parts.every((part) => token.test(part)))
        throw new Error("group image media type contains an invalid token byte");
    const canonical = mime.toLowerCase();
    return canonical === "image/jpg" ? "image/jpeg" : canonical;
}
/**
 * Encodes the ordered five vectors in `app-components/group-blossom-image-v1.md`.
 * Producers may supply a declared MIME which is stored in canonical form.
 */
export function encodeGroupBlossomImage(image) {
    if (image.kind === "empty")
        return new Uint8Array(5);
    const mediaType = canonicalizeGroupImageMediaType(image.mediaType);
    return new BinaryWriter()
        .opaque(image.imageHash, { min: 32, max: 32 })
        .opaque(image.imageKey, { min: 32, max: 32 })
        .opaque(image.imageNonce, { min: 12, max: 12 })
        .opaque(image.imageUploadKey, { min: 32, max: 32 })
        .opaque(encodeUtf8(mediaType), { min: 1, max: 128 })
        .build();
}
/** Strict bounded decoding with owned fields and canonical present/empty states. */
export function decodeGroupBlossomImage(data) {
    const reader = new BinaryReader(data);
    const imageHash = reader.opaque({ max: 32 }).slice();
    const imageKey = reader.opaque({ max: 32 }).slice();
    const imageNonce = reader.opaque({ max: 12 }).slice();
    const imageUploadKey = reader.opaque({ max: 32 }).slice();
    const mediaBytes = reader.opaque({ max: 128 });
    reader.end();
    if ([imageHash, imageKey, imageNonce, imageUploadKey, mediaBytes].every((field) => field.length === 0)) {
        return { kind: "empty" };
    }
    if (imageHash.length !== 32 ||
        imageKey.length !== 32 ||
        imageNonce.length !== 12 ||
        imageUploadKey.length !== 32 ||
        mediaBytes.length === 0) {
        throw new Error("group image component has invalid partial state");
    }
    const mediaType = new TextDecoder("utf-8", { fatal: true }).decode(mediaBytes);
    const canonicalBytes = encodeUtf8(canonicalizeGroupImageMediaType(mediaType));
    // Compare bytes as well as text: TextDecoder strips a leading UTF-8 BOM.
    if (canonicalBytes.length !== mediaBytes.length ||
        !canonicalBytes.every((byte, i) => byte === mediaBytes[i])) {
        throw new Error("group image media type is not canonical");
    }
    return {
        kind: "present",
        imageHash,
        imageKey,
        imageNonce,
        imageUploadKey,
        mediaType,
    };
}
