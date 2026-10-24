import { type MediaAttachment } from "../../core/media.js";
import type { MarmotGroup, StoredMedia } from "./marmot-group.js";
import type { EncryptMediaMetadata } from "./group-media-service.js";
/**
 * Injected network boundary. Implementations must honor signal and maxBytes and
 * apply their own destination/redirect policy before contacting any URL.
 */
export interface MediaBlobTransport {
    upload(request: {
        baseUrl: string;
        data: Uint8Array;
        ciphertextSha256: string;
        signal: AbortSignal;
        maxBytes: number;
    }): Promise<string>;
    fetch(request: {
        url: string;
        signal: AbortSignal;
        maxBytes: number;
    }): Promise<Uint8Array>;
}
export interface MediaTransferOptions {
    transport: MediaBlobTransport;
    signal?: AbortSignal;
    maxBytes?: number;
    timeoutMs?: number;
}
/** Upload all attachments and build one guarded kind-9 send intent. No MLS mutation. */
export declare function prepareMediaMessage(group: MarmotGroup<any, any>, files: readonly {
    blob: Blob;
    metadata: EncryptMediaMetadata;
}[], options: MediaTransferOptions & {
    caption?: string;
    tags?: string[][];
}): Promise<{
    rumor: import("applesauce-core/helpers").Rumor;
    attachments: MediaAttachment[];
    intent: {
        signal?: AbortSignal;
        expectedParent: string;
        kind: "applicationMessage";
        payload: Uint8Array;
    };
}>;
/** Fetch and decrypt exactly one reference; try fallbacks after corrupt blobs too. */
export declare function downloadMediaAttachment(group: MarmotGroup<any, any>, attachment: MediaAttachment, sourceParent: string, options: MediaTransferOptions): Promise<StoredMedia>;
/** Attachment failures are local; callers retain the original caption and tags. */
export declare function downloadMessageMedia(group: MarmotGroup<any, any>, tags: string[][], sourceParent: string, options: MediaTransferOptions): Promise<({
    data: Uint8Array;
    attachment: MediaAttachment;
    status: "ready";
    error?: undefined;
} | {
    status: "unavailable";
    attachment: MediaAttachment;
    error: unknown;
})[]>;
