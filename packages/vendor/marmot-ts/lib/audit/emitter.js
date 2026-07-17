/** @module @category Audit */
import { auditNowMs, createAuditEvent } from "./helpers.js";
import { safeAuditSink } from "./sink.js";
export class AuditEmitter {
    context;
    sink;
    #seq = 0;
    constructor(options) {
        this.sink = safeAuditSink(options.sink);
        this.context = {
            engineId: options.engineId,
            accountRef: options.accountRef,
            recorderSessionId: options.recorderSessionId,
            dataMode: options.dataMode ?? "obfuscated_sensitive_data",
            source: options.source,
            now: options.now ?? auditNowMs,
        };
    }
    record(event) {
        this.sink.record(event);
    }
    emit(kind, options) {
        const event = createAuditEvent(this.context, this.#seq++, kind, options);
        this.record(event);
        return event;
    }
}
export function createAuditEmitter(options) {
    return options ? new AuditEmitter(options) : undefined;
}
//# sourceMappingURL=emitter.js.map