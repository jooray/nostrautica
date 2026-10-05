import type { AuditLogWriter, AuditRecorder, MarmotAuditEvent } from "../../audit/index.js";
export declare class NodeJsonlAuditRecorder implements AuditRecorder {
    #private;
    readonly path: string;
    constructor(path: string);
    record(event: MarmotAuditEvent): void;
    flush(): Promise<void>;
    close(): Promise<void>;
}
export declare class NodeJsonlAuditWriter implements AuditLogWriter {
    #private;
    readonly path: string;
    constructor(path: string);
    appendLine(line: string): Promise<void>;
    flush(): Promise<void>;
    close(): Promise<void>;
}
/**
 * Non-identifying client labels sent as `X-Goggles-*` headers alongside an
 * upload. Account identity is NOT a header — it lives in the JSONL rows
 * (`account_ref` on every row + a `source_context` row at recorder open).
 */
export interface AuditLogUploadSource {
    deviceLabel?: string;
    platform?: string;
    appVersion?: string;
}
export interface AuditLogUploadOptions {
    /** Bearer token. Required for any non-loopback endpoint. */
    bearerToken?: string;
    /** Optional client labels, sent as `X-Goggles-*` headers. */
    source?: AuditLogUploadSource;
    /** Total request timeout in milliseconds (default 60_000). */
    timeoutMs?: number;
    /** Injectable `fetch`, for tests. Defaults to the global `fetch`. */
    fetch?: typeof fetch;
}
export interface AuditLogUploadResult {
    /** Local path that was uploaded. */
    path: string;
    /** HTTP status code returned by the tracker. */
    status: number;
    /** Number of bytes sent (the file size). */
    bytesSent: number;
}
/**
 * Upload one audit JSONL file to a Goggles tracker endpoint, mirroring the
 * reference app's `post_audit_log_file` contract: a `POST` of the raw NDJSON
 * body with `Content-Type: application/x-ndjson`, an optional bearer token, and
 * non-identifying `X-Goggles-*` source headers.
 *
 * Validation matches the reference: the basename must be `audit-*.jsonl`, the
 * file must be at most 64 MiB, the endpoint must be `https` (or loopback `http`
 * for local testing), and a non-loopback endpoint requires a bearer token.
 * Throws a normalized error (`HTTP <status>`, `request timed out`, or
 * `connection failed`) on failure.
 */
export declare function uploadAuditLogFile(path: string, endpoint: string, options?: AuditLogUploadOptions): Promise<AuditLogUploadResult>;
