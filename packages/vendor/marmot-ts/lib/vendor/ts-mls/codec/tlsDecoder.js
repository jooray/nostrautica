import { CodecError } from "../mlsError.js";
/** @public */
export function decode(dec, t, maxInputSize = 64000000) {
    if (t.length > maxInputSize)
        throw new CodecError("Payload larger than max allowed size, increase maxInputSize if you want to decode this");
    return dec(t, 0)?.[0];
}
export function mapDecoder(dec, f) {
    return (b, offset) => {
        const x = dec(b, offset);
        if (x !== undefined) {
            const [t, l] = x;
            return [f(t), l];
        }
    };
}
export function mapDecodersOption(rsDecoder, f) {
    return (b, offset) => {
        const initial = mapDecoders(rsDecoder, f)(b, offset);
        if (initial === undefined)
            return undefined;
        else {
            const [r, len] = initial;
            return r !== undefined ? [r, len] : undefined;
        }
    };
}
export function mapDecoders(rsDecoder, f) {
    const n = rsDecoder.length;
    return (b, offset) => {
        const values = new Array(n);
        let cursor = offset;
        for (let i = 0; i < n; i++) {
            const decoded = rsDecoder[i](b, cursor);
            if (decoded === undefined)
                return undefined;
            values[i] = decoded[0];
            cursor += decoded[1];
        }
        return [f(...values), cursor - offset];
    };
}
export function mapDecoderOption(dec, f) {
    return (b, offset) => {
        const x = dec(b, offset);
        if (x !== undefined) {
            const [t, l] = x;
            const u = f(t);
            return u !== undefined ? [u, l] : undefined;
        }
    };
}
export function flatMapDecoder(dec, f) {
    return flatMapDecoderAndMap(dec, f, (_t, u) => u);
}
export function orDecoder(decT, decU) {
    return (b, offset) => {
        const t = decT(b, offset);
        return t ? t : decU(b, offset);
    };
}
function flatMapDecoderAndMap(dec, f, g) {
    return (b, offset) => {
        const decodedT = dec(b, offset);
        if (decodedT !== undefined) {
            const [t, len] = decodedT;
            const rUDecoder = f(t);
            const decodedU = rUDecoder(b, offset + len);
            if (decodedU !== undefined) {
                const [u, len2] = decodedU;
                return [g(t, u), len + len2];
            }
        }
    };
}
export function succeedDecoder(t) {
    return () => [t, 0];
}
export function failDecoder() {
    return () => undefined;
}
