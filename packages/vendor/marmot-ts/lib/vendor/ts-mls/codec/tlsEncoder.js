/** @public */
export function encode(enc, t) {
    const [len, write] = enc(t);
    const buf = new ArrayBuffer(len);
    write(0, buf);
    return new Uint8Array(buf);
}
// Cache the DataView for the most recently used ArrayBuffer so that number
// encoders don't need to allocate a new DataView on every write. DataView
// carries no per-call state; the cache is only consulted synchronously inside
// a write-closure.
let _cachedBuf = null;
let _cachedView = null;
export function viewFor(buffer) {
    if (_cachedBuf !== buffer) {
        _cachedBuf = buffer;
        _cachedView = new DataView(buffer);
    }
    return _cachedView;
}
export function contramapBufferEncoder(enc, f) {
    return (u) => enc(f(u));
}
export function contramapBufferEncoders(encoders, toTuple) {
    return (value) => {
        const values = toTuple(value);
        const lengths = new Array(encoders.length);
        const writes = new Array(encoders.length);
        let totalLength = 0;
        for (let i = 0; i < encoders.length; i++) {
            const [len, write] = encoders[i](values[i]);
            lengths[i] = len;
            writes[i] = write;
            totalLength += len;
        }
        return [
            totalLength,
            (offset, buffer) => {
                let cursor = offset;
                for (let i = 0; i < writes.length; i++) {
                    writes[i](cursor, buffer);
                    cursor += lengths[i];
                }
            },
        ];
    };
}
export function composeBufferEncoders(encoders) {
    return (values) => contramapBufferEncoders(encoders, (t) => t)(values);
}
export const encVoid = [0, () => { }];
