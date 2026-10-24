import type { MediaAttachment } from "./types.js";
import type { MediaAttachment as MediaAttachmentV1 } from "./v1/types.js";
export type HistoricalMediaAttachment = MediaAttachment | MediaAttachmentV1;
/** Explicit version dispatch for history. Failed validation never tries another version. */
export declare function parseHistoricalMediaImetaTag(tag: string[]): HistoricalMediaAttachment | null;
