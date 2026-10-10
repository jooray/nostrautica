import { type MediaAttachment } from "./types.js";
/**
 * Why an `imeta` tag was rejected. The categories and their precedence match
 * MDK's `MediaAttachmentRejectionKind` so every implementation reports the same
 * verdict for the same tag (`refs/mdk/fixtures/encrypted-media/imeta-v2.json`).
 */
export type MediaAttachmentRejectionKind = "invalid_structure" | "unsupported_format" | "missing_field" | "duplicate_field" | "malformed_field";
/** A typed `imeta` rejection. Rejection is attachment-local. */
export declare class MediaAttachmentRejection extends Error {
    readonly kind: MediaAttachmentRejectionKind;
    constructor(kind: MediaAttachmentRejectionKind, message: string);
}
/** One `imeta` attachment of a message, in tag order, accepted or rejected. */
export type MediaAttachmentOutcome = {
    kind: "accepted";
    attachmentIndex: number;
    attachment: MediaAttachment;
} | {
    kind: "rejected";
    attachmentIndex: number;
    rejection: MediaAttachmentRejection;
};
/**
 * Serializes a {@link MediaAttachment} into an `imeta` tag array
 * (`features/encrypted-media.md` — Message Shape).
 *
 * Field order follows the spec and MDK: `v`, `locator`…, `ciphertext_sha256`,
 * `plaintext_sha256`, `nonce`, `m`, `filename`, optional `dim`, optional
 * `thumbhash`. The `v` value is `attachment.version`. The attachment MUST carry
 * at least one locator.
 *
 * @param attachment - A populated attachment (locators filled in after upload)
 * @returns A Nostr tag array beginning with `"imeta"`
 */
export declare function encodeMediaImetaTag(attachment: MediaAttachment): string[];
/**
 * Strictly decodes an encrypted-media attachment from an `imeta` tag, throwing
 * a typed {@link MediaAttachmentRejection} on failure.
 *
 * The `v` field is judged first, so the verdict for a tag with no `v`, a
 * duplicated `v`, or an unknown version (including legacy MIP-04 shapes) does
 * not depend on field order (MDK `parse_media_attachment`). `encrypted-media-v1`
 * tags are then decoded with the frozen v1 rules and `encrypted-media-v2` tags
 * with the v2 rules (`features/encrypted-media.md` — Validation). Fetchability
 * of a locator against group policy is NOT checked here.
 *
 * @throws {MediaAttachmentRejection}
 */
export declare function parseMediaAttachment(tag: string[]): MediaAttachment;
/**
 * Parses an `imeta` tag into a {@link MediaAttachment} (v1 or v2), or returns
 * `null` if the tag is not a valid encrypted-media reference. Use
 * {@link parseMediaAttachment} to learn why a tag was rejected.
 *
 * @param tag - A raw `imeta` tag array from a Nostr event
 */
export declare function parseMediaImetaTag(tag: string[]): MediaAttachment | null;
/**
 * Extracts all valid encrypted-media attachments (v1 and v2) from a tag list.
 *
 * Non-`imeta` tags and `imeta` tags that fail validation are skipped. Use
 * {@link getMediaAttachmentOutcomes} to keep rejected attachments' positions.
 *
 * @param tags - The `tags` array from a Nostr event or rumor
 * @returns Array of valid {@link MediaAttachment} objects (may be empty)
 */
export declare function getMediaAttachments(tags: string[][]): MediaAttachment[];
/**
 * Projects a message's `imeta` tags into ordered per-attachment outcomes (MDK
 * `media_attachment_outcomes_from_tags`). `attachmentIndex` is the position
 * among the message's `imeta` tags. A rejected attachment never hides its
 * valid siblings or the carrying message (v2 rejection is attachment-local).
 */
export declare function getMediaAttachmentOutcomes(tags: string[][]): MediaAttachmentOutcome[];
