/** @module @category Core - Encrypted Media */
import { canonicalizeMimeType, isValidHex, validateMediaFilename, } from "./canonical.js";
import { BLOSSOM_LOCATOR_KIND, ENCRYPTED_MEDIA_VERSION, } from "./types.js";
/** Single-occurrence `imeta` field names for `encrypted-media-v2`. */
const SINGLE_FIELDS = [
    "v",
    "ciphertext_sha256",
    "plaintext_sha256",
    "nonce",
    "m",
    "filename",
    "dim",
    "thumbhash",
];
/** A typed `imeta` rejection. Rejection is attachment-local. */
export class MediaAttachmentRejection extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.kind = kind;
        this.name = "MediaAttachmentRejection";
    }
}
function reject(kind, message) {
    throw new MediaAttachmentRejection(kind, message);
}
/**
 * Serializes a {@link MediaAttachment} into an `encrypted-media-v2` `imeta`
 * tag array (`features/encrypted-media.md` — Message Shape).
 *
 * Field order follows the spec: `v`, `locator`…, `ciphertext_sha256`,
 * `plaintext_sha256`, `nonce`, `m`, `filename`, optional `dim`, optional
 * `thumbhash`. The attachment MUST carry at least one locator.
 *
 * @param attachment - A populated attachment (locators filled in after upload)
 * @returns A Nostr tag array beginning with `"imeta"`
 */
export function encodeMediaImetaTag(attachment) {
    if (attachment.version !== ENCRYPTED_MEDIA_VERSION)
        throw new Error("invalid media version");
    if (attachment.locators.length === 0) {
        throw new Error("encodeMediaImetaTag: attachment has no locators");
    }
    const parts = ["imeta", `v ${ENCRYPTED_MEDIA_VERSION}`];
    for (const locator of attachment.locators) {
        parts.push(`locator ${locator.kind} ${locator.value}`);
    }
    parts.push(`ciphertext_sha256 ${attachment.ciphertextSha256}`);
    parts.push(`plaintext_sha256 ${attachment.plaintextSha256}`);
    parts.push(`nonce ${attachment.nonce}`);
    parts.push(`m ${attachment.mediaType}`);
    parts.push(`filename ${attachment.filename}`);
    if (attachment.dim !== undefined)
        parts.push(`dim ${attachment.dim}`);
    if (attachment.thumbhash !== undefined)
        parts.push(`thumbhash ${attachment.thumbhash}`);
    parseMediaAttachment(parts);
    return parts;
}
/**
 * Structural check of one v2 locator (MDK `validate_locator` for V2): kind and
 * value are non-empty, the value parses as a URL, and a `blossom-v1` URL uses
 * `http` or `https`. Destination safety and the locator's place in the group
 * policy are fetch-time decisions and never invalidate the reference.
 */
function validateLocatorV2(locator) {
    if (locator.kind.trim() === "" || locator.value.trim() === "") {
        reject("malformed_field", "media locator kind and value cannot be empty");
    }
    if (!URL.canParse(locator.value)) {
        reject("malformed_field", "media locator URL is invalid");
    }
    if (locator.kind === BLOSSOM_LOCATOR_KIND) {
        const protocol = new URL(locator.value).protocol;
        if (protocol !== "http:" && protocol !== "https:") {
            reject("malformed_field", "Blossom media locator URL scheme must be http or https");
        }
    }
}
/** Field names whose bare (value-less) form is a structural error in v2. */
const V2_VALUE_FIELDS = new Set([
    "locator",
    "ciphertext_sha256",
    "plaintext_sha256",
    "nonce",
    "m",
    "filename",
    "dim",
    "thumbhash",
]);
/**
 * Decodes an `encrypted-media-v2` tag, mirroring MDK `parse_media_attachment`
 * field for field: values are kept exactly as received (no trimming or MIME
 * repair), a present-empty `dim`/`thumbhash` stays `""`, and a duplicate
 * single-occurrence field is rejected rather than first- or last-wins.
 */
function decodeImetaV2(tag) {
    const locators = [];
    const single = new Map();
    for (const field of tag.slice(1)) {
        if (field === "blurhash" || field.startsWith("blurhash ")) {
            reject("malformed_field", "encrypted media uses thumbhash, not blurhash");
        }
        if (field.startsWith("locator ")) {
            const rest = field.slice("locator ".length);
            const sp = rest.indexOf(" ");
            if (sp === -1) {
                reject("invalid_structure", "media locator must include kind and value");
            }
            locators.push({ kind: rest.slice(0, sp), value: rest.slice(sp + 1) });
            continue;
        }
        const sp = field.indexOf(" ");
        if (sp === -1) {
            if (V2_VALUE_FIELDS.has(field)) {
                reject("invalid_structure", `media field ${field} is missing its value`);
            }
            continue;
        }
        const key = field.slice(0, sp);
        const value = field.slice(sp + 1);
        if (key === "v")
            continue; // judged in the version pre-pass
        if (SINGLE_FIELDS.includes(key)) {
            if (single.has(key)) {
                reject("duplicate_field", `media tag must contain exactly one ${key}`);
            }
            single.set(key, value);
        }
    }
    const required = (name) => {
        const value = single.get(name);
        if (value === undefined || value === "") {
            reject("missing_field", `media tag missing ${name}`);
        }
        return value;
    };
    const ciphertextSha256 = required("ciphertext_sha256");
    const plaintextSha256 = required("plaintext_sha256");
    const nonce = required("nonce");
    const filename = required("filename");
    const mediaType = required("m");
    // Reference validation, in MDK `MediaAttachmentReference::validate` order.
    if (!isValidHex(ciphertextSha256, 32))
        reject("malformed_field", "media ciphertext_sha256 must be 32 hex bytes");
    if (!isValidHex(plaintextSha256, 32))
        reject("malformed_field", "media plaintext_sha256 must be 32 hex bytes");
    if (!isValidHex(nonce, 12))
        reject("malformed_field", "media nonce must be 12 bytes");
    if (locators.length === 0) {
        reject("missing_field", "media attachment must include at least one locator");
    }
    for (const locator of locators)
        validateLocatorV2(locator);
    try {
        validateMediaFilename(filename);
    }
    catch (err) {
        reject("malformed_field", `media file name is invalid: ${err.message}`);
    }
    let canonical;
    try {
        canonical = canonicalizeMimeType(mediaType);
    }
    catch (err) {
        reject("malformed_field", err.message);
    }
    if (canonical !== mediaType) {
        reject("malformed_field", "media type is not canonical for encrypted-media-v2");
    }
    return {
        version: ENCRYPTED_MEDIA_VERSION,
        locators,
        ciphertextSha256,
        plaintextSha256,
        nonce,
        mediaType,
        filename,
        ...(single.has("dim") ? { dim: single.get("dim") } : {}),
        ...(single.has("thumbhash") ? { thumbhash: single.get("thumbhash") } : {}),
    };
}
/**
 * Strictly parses one current-profile v2 reference, throwing a typed rejection.
 * Version errors take precedence over other fields, matching MDK. Historical
 * v1 references remain available only through the explicit v1/history helpers.
 */
export function parseMediaAttachment(tag) {
    if (tag[0] !== "imeta")
        reject("invalid_structure", "media tag must be imeta");
    let version;
    for (const field of tag.slice(1)) {
        if (field === "v")
            reject("invalid_structure", "media field v is missing its value");
        if (!field.startsWith("v "))
            continue;
        if (version !== undefined)
            reject("duplicate_field", "media tag must contain exactly one version");
        version = field.slice(2);
        if (version !== ENCRYPTED_MEDIA_VERSION)
            reject("unsupported_format", "media version is not supported");
    }
    if (!version)
        reject("unsupported_format", "media tag missing v");
    return decodeImetaV2(tag);
}
/**
 * Parse one v2 reference. Invalid references are attachment-local: retain the
 * carrying caption and all valid sibling attachments.
 */
export function parseMediaImetaTag(tag) {
    try {
        return parseMediaAttachment(tag);
    }
    catch {
        return null;
    }
}
/**
 * Extracts all valid `encrypted-media-v2` attachments from a tag list.
 *
 * Non-`imeta` tags and `imeta` tags that fail validation are skipped.
 *
 * @param tags - The `tags` array from a Nostr event or rumor
 * @returns Array of valid {@link MediaAttachment} objects (may be empty)
 */
export function getMediaAttachments(tags) {
    return tags
        .filter((t) => t[0] === "imeta")
        .map(parseMediaImetaTag)
        .filter((a) => a !== null);
}
/**
 * Projects a message's `imeta` tags into ordered per-attachment outcomes (MDK
 * `media_attachment_outcomes_from_tags`). `attachmentIndex` is the position
 * among the message's `imeta` tags. A rejected attachment never hides its
 * valid siblings or the carrying message (v2 rejection is attachment-local).
 */
export function getMediaAttachmentOutcomes(tags) {
    return tags
        .filter((t) => t[0] === "imeta")
        .map((tag, attachmentIndex) => {
        try {
            return {
                kind: "accepted",
                attachmentIndex,
                attachment: parseMediaAttachment(tag),
            };
        }
        catch (err) {
            const rejection = err instanceof MediaAttachmentRejection
                ? err
                : new MediaAttachmentRejection("malformed_field", err instanceof Error ? err.message : String(err));
            return { kind: "rejected", attachmentIndex, rejection };
        }
    });
}
