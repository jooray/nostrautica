import type { GenericKeyValueStore } from "../utils/key-value.js";
/**
 * A simple in-memory implementation of {@link GenericKeyValueStore}.
 *
 * Data lives only for the lifetime of the process / page — nothing is written
 * to disk. Useful as a default ephemeral backend when persistence is not
 * required or as a drop-in for testing.
 */
export declare class InMemoryKeyValueStore<T> implements GenericKeyValueStore<T> {
    private readonly store;
    getItem(key: string): Promise<T | null>;
    setItem(key: string, value: T): Promise<T>;
    removeItem(key: string): Promise<void>;
    clear(): Promise<void>;
    keys(): Promise<string[]>;
}
