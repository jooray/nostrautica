import type { AuditContextOptions, AuditEmitContext, AuditEventContext, AuditEventKind, AuditSink, MarmotAuditEvent } from "./types.js";
export declare class AuditEmitter implements AuditSink {
    #private;
    readonly context: AuditEmitContext;
    readonly sink: AuditSink;
    constructor(options: AuditContextOptions & {
        sink?: AuditSink;
    });
    record(event: MarmotAuditEvent): void;
    emit(kind: AuditEventKind, options?: {
        groupRef?: string;
        context?: AuditEventContext;
    }): MarmotAuditEvent;
}
export declare function createAuditEmitter(options: (AuditContextOptions & {
    sink?: AuditSink;
}) | undefined): AuditEmitter | undefined;
