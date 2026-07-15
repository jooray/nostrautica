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
