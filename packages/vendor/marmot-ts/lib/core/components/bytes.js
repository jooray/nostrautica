/** @module @category Core - App Components */
/** Lexicographic comparison over raw bytes (matches Rust `[u8]`/`&[u8]` Ord). */
export function compareBytes(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i])
            return a[i] - b[i];
    }
    return a.length - b.length;
}
//# sourceMappingURL=bytes.js.map