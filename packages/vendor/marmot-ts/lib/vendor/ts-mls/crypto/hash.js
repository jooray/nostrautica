import { composeBufferEncoders, encode } from "../codec/tlsEncoder.js";
import { varLenDataEncoder } from "../codec/variableLength.js";
const _textEncoder = new TextEncoder();
const _refHashEncoder = composeBufferEncoders([varLenDataEncoder, varLenDataEncoder]);
export function refhash(label, value, h) {
    return h.digest(encodeRefHash(label, value));
}
function encodeRefHash(label, value) {
    return encode(_refHashEncoder, [_textEncoder.encode(label), value]);
}
