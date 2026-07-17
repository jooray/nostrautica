/** @module @category Extra - Audit */
/// <reference types="node" />
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
export class NodeJsonlAuditRecorder {
    path;
    #fd;
    #seq = 0;
    #closed = false;
    constructor(path) {
        this.path = path;
        mkdirSync(dirname(path), { recursive: true });
        this.#fd = openSync(path, "a");
    }
    record(event) {
        if (this.#closed)
            return;
        appendFileSync(this.#fd, `${JSON.stringify({ ...event, seq: this.#seq++ })}\n`, "utf8");
    }
    async flush() {
        if (!this.#closed)
            fsyncSync(this.#fd);
    }
    async close() {
        if (this.#closed)
            return;
        fsyncSync(this.#fd);
        closeSync(this.#fd);
        this.#closed = true;
    }
}
export class NodeJsonlAuditWriter {
    path;
    #handle;
    constructor(path) {
        this.path = path;
        this.#handle = this.#open();
    }
    async #open() {
        await mkdir(dirname(this.path), { recursive: true });
        return open(this.path, "a");
    }
    async appendLine(line) {
        const handle = await this.#handle;
        await handle.appendFile(line, "utf8");
    }
    async flush() {
        const handle = await this.#handle;
        await handle.sync();
    }
    async close() {
        const handle = await this.#handle;
        await handle.close();
    }
}
//# sourceMappingURL=node.js.map