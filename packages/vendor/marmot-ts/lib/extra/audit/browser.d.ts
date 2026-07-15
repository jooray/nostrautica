/** @module @category Extra - Audit */
import type { AuditLogWriter } from "../../audit/index.js";
export type IndexedDbAuditWriterOptions = {
    databaseName?: string;
    storeName?: string;
    logId: string;
};
export declare class IndexedDbAuditWriter implements AuditLogWriter {
    #private;
    readonly databaseName: string;
    readonly storeName: string;
    readonly logId: string;
    constructor(options: IndexedDbAuditWriterOptions);
    appendLine(line: string): Promise<void>;
    flush(): Promise<void>;
    close(): Promise<void>;
}
export type OpfsAuditWriterOptions = {
    directory?: string;
    fileName: string;
};
export declare class OpfsAuditWriter implements AuditLogWriter {
    #private;
    readonly directory: string | undefined;
    readonly fileName: string;
    constructor(options: OpfsAuditWriterOptions);
    appendLine(line: string): Promise<void>;
    flush(): Promise<void>;
    close(): Promise<void>;
}
export type AutoBrowserAuditWriterOptions = ({
    backend?: "auto" | "opfs";
} & OpfsAuditWriterOptions) | ({
    backend: "indexeddb";
} & IndexedDbAuditWriterOptions);
export declare class AutoBrowserAuditWriter implements AuditLogWriter {
    readonly writer: AuditLogWriter;
    private constructor();
    static open(options: AutoBrowserAuditWriterOptions): Promise<AutoBrowserAuditWriter>;
    appendLine(line: string): void | Promise<void>;
    flush(): void | Promise<void>;
    close(): void | Promise<void>;
}
