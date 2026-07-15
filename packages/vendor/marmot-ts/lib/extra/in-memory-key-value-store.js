/**
 * A simple in-memory implementation of {@link GenericKeyValueStore}.
 *
 * Data lives only for the lifetime of the process / page — nothing is written
 * to disk. Useful as a default ephemeral backend when persistence is not
 * required or as a drop-in for testing.
 */
export class InMemoryKeyValueStore {
    store = new Map();
    async getItem(key) {
        return this.store.get(key) ?? null;
    }
    async setItem(key, value) {
        this.store.set(key, value);
        return value;
    }
    async removeItem(key) {
        this.store.delete(key);
    }
    async clear() {
        this.store.clear();
    }
    async keys() {
        return Array.from(this.store.keys());
    }
}
//# sourceMappingURL=in-memory-key-value-store.js.map