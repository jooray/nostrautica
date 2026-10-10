import { varLenTypeEncoder, varLenTypeDecoder } from "./codec/variableLength.js";
import { contramapBufferEncoders } from "./codec/tlsEncoder.js";
import { mapDecoders } from "./codec/tlsDecoder.js";
import { uint16Decoder, uint16Encoder } from "./codec/number.js";
import { arraysEqual } from "./util/array.js";
export const requiredCapabilitiesEncoder = contramapBufferEncoders([varLenTypeEncoder(uint16Encoder), varLenTypeEncoder(uint16Encoder), varLenTypeEncoder(uint16Encoder)], (rc) => [rc.extensionTypes, rc.proposalTypes, rc.credentialTypes]);
export const requiredCapabilitiesDecoder = mapDecoders([varLenTypeDecoder(uint16Decoder), varLenTypeDecoder(uint16Decoder), varLenTypeDecoder(uint16Decoder)], (extensionTypes, proposalTypes, credentialTypes) => ({ extensionTypes, proposalTypes, credentialTypes }));
export function requiredCapabilitiesEqual(a, b) {
    return (arraysEqual(a.extensionTypes, b.extensionTypes) &&
        arraysEqual(a.proposalTypes, b.proposalTypes) &&
        arraysEqual(a.credentialTypes, b.credentialTypes));
}
