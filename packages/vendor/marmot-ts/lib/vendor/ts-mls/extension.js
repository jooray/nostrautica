import { uint16Decoder, uint16Encoder } from "./codec/number.js";
import { decode, flatMapDecoder, mapDecoder, mapDecoderOption, mapDecoders } from "./codec/tlsDecoder.js";
import { contramapBufferEncoders, encode } from "./codec/tlsEncoder.js";
import { varLenDataDecoder, varLenDataEncoder, varLenTypeDecoder, varLenTypeEncoder } from "./codec/variableLength.js";
import { defaultExtensionTypes, isDefaultExtensionTypeValue } from "./defaultExtensionType.js";
import { externalSenderDecoder, externalSenderEncoder } from "./externalSender.js";
import { UsageError } from "./mlsError.js";
import { requiredCapabilitiesDecoder, requiredCapabilitiesEncoder, requiredCapabilitiesEqual, } from "./requiredCapabilities.js";
import { constantTimeEqual } from "./util/constantTimeCompare.js";
/** @public */
export function makeCustomExtension(extension) {
    if (isDefaultExtensionTypeValue(extension.extensionType)) {
        throw new UsageError("Cannot create custom exception with default extension type");
    }
    return extension;
}
/** @public */
export function isDefaultExtension(e) {
    return isDefaultExtensionTypeValue(e.extensionType);
}
export const extensionEncoder = contramapBufferEncoders([uint16Encoder, varLenDataEncoder], (e) => {
    if (isDefaultExtension(e)) {
        if (e.extensionType === defaultExtensionTypes.required_capabilities) {
            return [e.extensionType, encode(requiredCapabilitiesEncoder, e.extensionData)];
        }
        else if (e.extensionType === defaultExtensionTypes.external_senders) {
            return [e.extensionType, encode(varLenTypeEncoder(externalSenderEncoder), e.extensionData)];
        }
        else if (e.extensionType === defaultExtensionTypes.external_pub) {
            return [e.extensionType, encode(varLenDataEncoder, e.extensionData)];
        }
        return [e.extensionType, e.extensionData];
    }
    else
        return [e.extensionType, e.extensionData];
});
export const customExtensionDecoder = mapDecoders([uint16Decoder, varLenDataDecoder], (extensionType, extensionData) => ({ extensionType, extensionData }));
export const leafNodeExtensionDecoder = flatMapDecoder(uint16Decoder, (extensionType) => {
    if (extensionType === defaultExtensionTypes.application_id) {
        return mapDecoder(varLenDataDecoder, (extensionData) => {
            return { extensionType: defaultExtensionTypes.application_id, extensionData };
        });
    }
    else
        return mapDecoder(varLenDataDecoder, (extensionData) => ({ extensionType, extensionData }));
});
export const groupInfoExtensionDecoder = flatMapDecoder(uint16Decoder, (extensionType) => {
    if (extensionType === defaultExtensionTypes.external_pub) {
        return (b, offset) => {
            const x = varLenDataDecoder(b, offset);
            if (!x)
                return undefined;
            const res = varLenDataDecoder(x[0], 0);
            if (!res)
                return undefined;
            return [{ extensionType: defaultExtensionTypes.external_pub, extensionData: res[0] }, x[1]];
        };
    }
    else if (extensionType === defaultExtensionTypes.ratchet_tree) {
        return mapDecoder(varLenDataDecoder, (extensionData) => {
            return { extensionType: defaultExtensionTypes.ratchet_tree, extensionData };
        });
    }
    else
        return mapDecoder(varLenDataDecoder, (extensionData) => ({ extensionType, extensionData }));
});
export const groupContextExtensionDecoder = flatMapDecoder(uint16Decoder, (extensionType) => {
    if (extensionType === defaultExtensionTypes.external_senders) {
        return mapDecoderOption(varLenDataDecoder, (extensionData) => {
            const res = decode(varLenTypeDecoder(externalSenderDecoder), extensionData);
            if (res)
                return { extensionType: defaultExtensionTypes.external_senders, extensionData: res };
        });
    }
    else if (extensionType === defaultExtensionTypes.required_capabilities) {
        return mapDecoderOption(varLenDataDecoder, (extensionData) => {
            const res = decode(requiredCapabilitiesDecoder, extensionData);
            if (res)
                return { extensionType: defaultExtensionTypes.required_capabilities, extensionData: res };
        });
    }
    else
        return mapDecoder(varLenDataDecoder, (extensionData) => ({ extensionType, extensionData }));
});
function extensionEqual(a, b) {
    if (a.extensionType !== b.extensionType)
        return false;
    if (isDefaultExtension(a)) {
        if (a.extensionType === defaultExtensionTypes.required_capabilities) {
            return requiredCapabilitiesEqual(a.extensionData, b.extensionData);
        }
        else if (a.extensionType === defaultExtensionTypes.external_senders) {
            return constantTimeEqual(encode(varLenTypeEncoder(externalSenderEncoder), a.extensionData), encode(varLenTypeEncoder(externalSenderEncoder), b.extensionData));
        }
    }
    //TypeScript isn't smart enough to figure out the extensionTypes are the same
    return constantTimeEqual(a.extensionData, b.extensionData);
}
export function extensionsEqual(a, b) {
    if (a.length !== b.length)
        return false;
    return a.every((val, i) => extensionEqual(val, b[i]));
}
export function extensionsSupportedByCapabilities(requiredExtensions, capabilities) {
    return requiredExtensions
        .filter((ex) => !isDefaultExtensionTypeValue(ex.extensionType))
        .every((ex) => capabilities.extensions.includes(ex.extensionType));
}
