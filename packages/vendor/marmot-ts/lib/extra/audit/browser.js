export class IndexedDbAuditWriter {
    databaseName;
    storeName;
    logId;
    #db;
    #index = 0;
    constructor(options) {
        this.databaseName = options.databaseName ?? "marmot-audit-logs";
        this.storeName = options.storeName ?? "lines";
        this.logId = options.logId;
        this.#db = openAuditDatabase(this.databaseName, this.storeName);
    }
    async appendLine(line) {
        const db = await this.#db;
        await idbRequest((resolve, reject) => {
            const tx = db.transaction(this.storeName, "readwrite");
            const store = tx.objectStore(this.storeName);
            store.put({ logId: this.logId, index: this.#index++, line }, `${this.logId}:${this.#index}`);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
            tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
        });
    }
    async flush() { }
    async close() {
        const db = await this.#db;
        db.close();
    }
}
export class OpfsAuditWriter {
    directory;
    fileName;
    #file;
    constructor(options) {
        this.directory = options.directory;
        this.fileName = options.fileName;
        this.#file = openOpfsFile(options);
    }
    async appendLine(line) {
        const file = await this.#file;
        const existing = await file.getFile();
        const writable = await file.createWritable({ keepExistingData: true });
        await writable.seek(existing.size);
        await writable.write(line);
        await writable.close();
    }
    async flush() { }
    async close() { }
}
export class AutoBrowserAuditWriter {
    writer;
    constructor(writer) {
        this.writer = writer;
    }
    static async open(options) {
        if (options.backend === "indexeddb")
            return new AutoBrowserAuditWriter(new IndexedDbAuditWriter(options));
        if (options.backend === "opfs" || supportsOpfs())
            return new AutoBrowserAuditWriter(new OpfsAuditWriter(options));
        return new AutoBrowserAuditWriter(new IndexedDbAuditWriter({ logId: options.fileName }));
    }
    appendLine(line) {
        return this.writer.appendLine(line);
    }
    flush() {
        return this.writer.flush?.();
    }
    close() {
        return this.writer.close?.();
    }
}
function openAuditDatabase(databaseName, storeName) {
    return idbRequest((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(storeName))
                db.createObjectStore(storeName);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
}
function idbRequest(run) {
    return new Promise((resolve, reject) => run(resolve, reject));
}
async function openOpfsFile(options) {
    const root = await navigator.storage.getDirectory();
    const directory = options.directory
        ? await root.getDirectoryHandle(options.directory, { create: true })
        : root;
    return directory.getFileHandle(options.fileName, { create: true });
}
function supportsOpfs() {
    return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
}
//# sourceMappingURL=browser.js.map