export class JsonlAuditRecorder {
    writer;
    #writeChain = Promise.resolve();
    #closed = false;
    constructor(options) {
        this.writer = options.writer;
    }
    record(event) {
        if (this.#closed)
            return;
        this.#writeChain = this.#writeChain.then(() => Promise.resolve(this.writer.appendLine(`${JSON.stringify(event)}\n`)));
    }
    async flush() {
        await this.#writeChain;
        await this.writer.flush?.();
    }
    async close() {
        if (this.#closed)
            return;
        this.#closed = true;
        await this.flush();
        await this.writer.close?.();
    }
}
//# sourceMappingURL=recorder.js.map