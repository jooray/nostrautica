import type { GroupBlossomImagePresent } from "../../core/components/blossom-image.js";
export interface GroupImageTransportRequest {
    url: string;
    method: "GET" | "PUT";
    headers: Record<string, string>;
    body?: Uint8Array;
    signal: AbortSignal;
    maxBytes: number;
    deadlineMs: number;
    /** Error responses have an independent small diagnostic budget. */
    maxDiagnosticBytes?: number;
}
export interface GroupImageTransportResponse {
    status: number;
    body: Uint8Array;
    headers?: Record<string, string>;
}
/** Custom transports must enforce streaming limits and honor the signal. */
export type GroupImageTransport = (request: GroupImageTransportRequest) => Promise<GroupImageTransportResponse>;
export declare class GroupImageRequestError extends Error {
    readonly reason: "endpoint-absent" | "contact-denied" | "byte-limit" | "deadline" | "transport" | "invalid-response" | "cancelled";
    constructor(reason: "endpoint-absent" | "contact-denied" | "byte-limit" | "deadline" | "transport" | "invalid-response" | "cancelled");
}
/** Whole-blob fetch with no credentials, redirects, referrer or HTTP cache. */
export declare const fetchGroupImageTransport: GroupImageTransport;
/** Validate before policy or transport; only origin-root profile paths contact HTTP. */
export declare function validateGroupImageRequestUrl(value: string, method: "GET" | "PUT"): void;
export declare function normalizeGroupImageEndpoint(value: string): string;
export declare function createGroupImageUploadAuthorization(endpoint: string, metadata: GroupBlossomImagePresent): string;
/** Reject changed or broadened image credentials before any external contact. */
export declare function validateGroupImageUploadRequest(request: Pick<GroupImageTransportRequest, "url" | "method" | "headers" | "body">): void;
export declare function validateGroupImageUploadResponse(response: GroupImageTransportResponse, endpoint: string, hash: string, size: number): void;
