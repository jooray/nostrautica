/** @module @category Audit */
import type { AuditContextOptions, AuditLogWriter, AuditRecorder, MarmotAuditEvent } from "./types-internal.js";
export type { AuditLogWriter } from "./types-internal.js";
export declare class JsonlAuditRecorder implements AuditRecorder {
    #private;
    readonly writer: AuditLogWriter;
    constructor(options: Partial<AuditContextOptions> & {
        writer: AuditLogWriter;
    });
    record(event: MarmotAuditEvent): void;
    flush(): Promise<void>;
    close(): Promise<void>;
}
