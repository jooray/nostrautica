import { contramapBufferEncoders } from "./codec/tlsEncoder.js";
import { mapDecoders } from "./codec/tlsDecoder.js";
import { varLenTypeDecoder, varLenTypeEncoder } from "./codec/variableLength.js";
import { uint16Decoder, uint16Encoder } from "./codec/number.js";
export const capabilitiesEncoder = contramapBufferEncoders([
    varLenTypeEncoder(uint16Encoder),
    varLenTypeEncoder(uint16Encoder),
    varLenTypeEncoder(uint16Encoder),
    varLenTypeEncoder(uint16Encoder),
    varLenTypeEncoder(uint16Encoder),
], (cap) => [cap.versions, cap.ciphersuites, cap.extensions, cap.proposals, cap.credentials]);
export const capabilitiesDecoder = mapDecoders([
    varLenTypeDecoder(uint16Decoder),
    varLenTypeDecoder(uint16Decoder),
    varLenTypeDecoder(uint16Decoder),
    varLenTypeDecoder(uint16Decoder),
    varLenTypeDecoder(uint16Decoder),
], (versions, ciphersuites, extensions, proposals, credentials) => ({
    versions,
    ciphersuites,
    extensions,
    proposals,
    credentials,
}));
