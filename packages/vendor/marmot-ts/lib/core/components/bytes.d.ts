/** @module @category Core - App Components */
/** Lexicographic comparison over raw bytes (matches Rust `[u8]`/`&[u8]` Ord). */
export declare function compareBytes(a: Uint8Array, b: Uint8Array): number;
/** Equality for optional byte arrays; two absent values are equal. */
export declare function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean;
