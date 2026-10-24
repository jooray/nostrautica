import { type MediaAttachment } from "./types.js";
/**
 * Why an `imeta` tag was rejected. The categories and their precedence match
 * MDK's `MediaAttachmentRejectionKind` so every implementation reports the same
 * verdict for the same tag (`fixtures/encrypted-media/imeta-v2.json` in MDK).
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
export declare function encodeMediaImetaTag(attachment: MediaAttachment): string[];
/**
 * Strictly parses one current-profile v2 reference, throwing a typed rejection.
 * Version errors take precedence over other fields, matching MDK. Historical
 * v1 references remain available only through the explicit v1/history helpers.
 */
export declare function parseMediaAttachment(tag: string[]): MediaAttachment;
/**
 * Parse one v2 reference. Invalid references are attachment-local: retain the
 * carrying caption and all valid sibling attachments.
 */
export declare function parseMediaImetaTag(tag: string[]): MediaAttachment | null;
/**
 * Extracts all valid `encrypted-media-v2` attachments from a tag list.
 *
 * Non-`imeta` tags and `imeta` tags that fail validation are skipped.
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
