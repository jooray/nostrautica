import { varLenDataEncoder } from "../codec/variableLength.js";
import { uint16Encoder, uint32Encoder } from "../codec/number.js";
import { composeBufferEncoders, encode } from "../codec/tlsEncoder.js";
const _textEncoder = new TextEncoder();
const _infoEncoder = composeBufferEncoders([uint16Encoder, varLenDataEncoder, varLenDataEncoder]);
const _emptyContext = new Uint8Array(0);
const _labelCache = new Map();
function labelBytes(label) {
    let bytes = _labelCache.get(label);
    if (bytes === undefined) {
        bytes = _textEncoder.encode(`MLS 1.0 ${label}`);
        _labelCache.set(label, bytes);
    }
    return bytes;
}
export function expandWithLabel(secret, label, context, length, kdf) {
    return kdf.expand(secret, encode(_infoEncoder, [length, labelBytes(label), context]), length);
}
export async function deriveSecret(secret, label, kdf) {
    return expandWithLabel(secret, label, _emptyContext, kdf.size, kdf);
}
export async function deriveTreeSecret(secret, label, generation, length, kdf) {
    return expandWithLabel(secret, label, encode(uint32Encoder, generation), length, kdf);
}
