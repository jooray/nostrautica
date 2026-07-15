import { type MediaAttachment } from "./types.js";
/**
 * Serializes a {@link MediaAttachment} into an `encrypted-media-v1` `imeta`
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
 * Parses an `imeta` tag into a {@link MediaAttachment}, or returns `null` if the
 * tag is not a valid `encrypted-media-v1` attachment.
 *
 * A `null` result means the media reference is invalid and MUST be dropped (the
 * containing message should be dropped too for a host-safety failure). See
 * {@link decodeMediaImetaTag} for the exact conditions.
 *
 * @param tag - A raw `imeta` tag array from a Nostr event
 */
export declare function parseMediaImetaTag(tag: string[]): MediaAttachment | null;
/**
 * Extracts all valid `encrypted-media-v1` attachments from a tag list.
 *
 * Non-`imeta` tags and `imeta` tags that fail validation are skipped.
 *
 * @param tags - The `tags` array from a Nostr event or rumor
 * @returns Array of valid {@link MediaAttachment} objects (may be empty)
 */
export declare function getMediaAttachments(tags: string[][]): MediaAttachment[];
