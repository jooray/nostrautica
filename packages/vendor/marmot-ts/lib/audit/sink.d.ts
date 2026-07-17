/** @module @category Audit */
import type { AuditSink, MarmotAuditEvent } from "./types.js";
export declare class NoopAuditSink implements AuditSink {
    record(_event: MarmotAuditEvent): void;
}
export declare class MemoryAuditSink implements AuditSink {
    readonly events: MarmotAuditEvent[];
    record(event: MarmotAuditEvent): void;
}
export declare class SafeAuditSink implements AuditSink {
    readonly inner: AuditSink;
    constructor(inner: AuditSink);
    record(event: MarmotAuditEvent): void;
}
export declare const noopAuditSink: NoopAuditSink;
export declare function safeAuditSink(sink: AuditSink | undefined): AuditSink;
