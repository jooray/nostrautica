export class NoopAuditSink {
    record(_event) { }
}
export class MemoryAuditSink {
    events = [];
    record(event) {
        this.events.push(event);
    }
}
export class SafeAuditSink {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    record(event) {
        try {
            this.inner.record(event);
        }
        catch {
            // Audit must never affect protocol progress.
        }
    }
}
export const noopAuditSink = new NoopAuditSink();
export function safeAuditSink(sink) {
    return sink ? new SafeAuditSink(sink) : noopAuditSink;
}
//# sourceMappingURL=sink.js.map