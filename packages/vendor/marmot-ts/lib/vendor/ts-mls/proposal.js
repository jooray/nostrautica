import { uint16Decoder, uint32Decoder, uint16Encoder, uint32Encoder } from "./codec/number.js";
import { flatMapDecoder, mapDecoder, mapDecoders, orDecoder, succeedDecoder } from "./codec/tlsDecoder.js";
import { contramapBufferEncoder, contramapBufferEncoders } from "./codec/tlsEncoder.js";
import { varLenDataDecoder, varLenTypeDecoder, varLenDataEncoder, varLenTypeEncoder } from "./codec/variableLength.js";
import { extensionEncoder, groupContextExtensionDecoder } from "./extension.js";
import { keyPackageDecoder, keyPackageEncoder } from "./keyPackage.js";
import { pskIdDecoder, pskIdEncoder } from "./presharedkey.js";
import { decodeDefaultProposalTypeValue, defaultProposalTypeValueEncoder, defaultProposalTypes, isDefaultProposalTypeValue, } from "./defaultProposalType.js";
import { protocolVersionDecoder, protocolVersionEncoder } from "./protocolVersion.js";
import { leafNodeUpdateDecoder, leafNodeEncoder } from "./leafNode.js";
import { appDataUpdateDecoder, appDataUpdateEncoder, appDataUpdateProposalType, } from "./appDataUpdate.js";
import { selfRemoveProposalType } from "./selfRemove.js";
import { UsageError } from "./mlsError.js";
export const addEncoder = contramapBufferEncoder(keyPackageEncoder, (a) => a.keyPackage);
export const addDecoder = mapDecoder(keyPackageDecoder, (keyPackage) => ({ keyPackage }));
export const updateEncoder = contramapBufferEncoder(leafNodeEncoder, (u) => u.leafNode);
export const updateDecoder = mapDecoder(leafNodeUpdateDecoder, (leafNode) => ({ leafNode }));
export const removeEncoder = contramapBufferEncoder(uint32Encoder, (r) => r.removed);
export const removeDecoder = mapDecoder(uint32Decoder, (removed) => ({ removed }));
export const pskEncoder = contramapBufferEncoder(pskIdEncoder, (p) => p.preSharedKeyId);
export const pskDecoder = mapDecoder(pskIdDecoder, (preSharedKeyId) => ({ preSharedKeyId }));
export const reinitEncoder = contramapBufferEncoders([varLenDataEncoder, protocolVersionEncoder, uint16Encoder, varLenTypeEncoder(extensionEncoder)], (r) => [r.groupId, r.version, r.cipherSuite, r.extensions]);
export const reinitDecoder = mapDecoders([varLenDataDecoder, protocolVersionDecoder, uint16Decoder, varLenTypeDecoder(groupContextExtensionDecoder)], (groupId, version, cipherSuite, extensions) => ({ groupId, version, cipherSuite, extensions }));
export const externalInitEncoder = contramapBufferEncoder(varLenDataEncoder, (e) => e.kemOutput);
export const externalInitDecoder = mapDecoder(varLenDataDecoder, (kemOutput) => ({ kemOutput }));
export const groupContextExtensionsEncoder = contramapBufferEncoder(varLenTypeEncoder(extensionEncoder), (g) => g.extensions);
export const groupContextExtensionsDecoder = mapDecoder(varLenTypeDecoder(groupContextExtensionDecoder), (extensions) => ({ extensions }));
/** @public */
export function isDefaultProposal(p) {
    return isDefaultProposalTypeValue(p.proposalType);
}
/** @public */
export function isAppDataUpdateProposal(p) {
    return p.proposalType === appDataUpdateProposalType && "appDataUpdate" in p;
}
/** @public */
export function isSelfRemoveProposal(p) {
    return p.proposalType === selfRemoveProposalType && !("proposalData" in p);
}
/** @public */
export function isCustomProposal(p) {
    return !isDefaultProposal(p) && !isAppDataUpdateProposal(p) && !isSelfRemoveProposal(p);
}
const proposalAddEncoder = contramapBufferEncoders([defaultProposalTypeValueEncoder, addEncoder], (p) => [p.proposalType, p.add]);
const proposalUpdateEncoder = contramapBufferEncoders([defaultProposalTypeValueEncoder, updateEncoder], (p) => [p.proposalType, p.update]);
const proposalRemoveEncoder = contramapBufferEncoders([defaultProposalTypeValueEncoder, removeEncoder], (p) => [p.proposalType, p.remove]);
const proposalPSKEncoder = contramapBufferEncoders([defaultProposalTypeValueEncoder, pskEncoder], (p) => [p.proposalType, p.psk]);
const proposalReinitEncoder = contramapBufferEncoders([defaultProposalTypeValueEncoder, reinitEncoder], (p) => [p.proposalType, p.reinit]);
const proposalExternalInitEncoder = contramapBufferEncoders([defaultProposalTypeValueEncoder, externalInitEncoder], (p) => [p.proposalType, p.externalInit]);
const proposalGroupContextExtensionsEncoder = contramapBufferEncoders([defaultProposalTypeValueEncoder, groupContextExtensionsEncoder], (p) => [p.proposalType, p.groupContextExtensions]);
const proposalAppDataUpdateEncoder = contramapBufferEncoders([uint16Encoder, appDataUpdateEncoder], (p) => [p.proposalType, p.appDataUpdate]);
const proposalCustomEncoder = contramapBufferEncoders([uint16Encoder, varLenDataEncoder], (p) => [p.proposalType, p.proposalData]);
// self_remove has an empty body: just the proposal type, no length-prefixed data.
const proposalSelfRemoveEncoder = contramapBufferEncoder(uint16Encoder, (p) => p.proposalType);
export const proposalEncoder = (p) => {
    if (isAppDataUpdateProposal(p))
        return proposalAppDataUpdateEncoder(p);
    if (!isDefaultProposal(p)) {
        if (isSelfRemoveProposal(p))
            return proposalSelfRemoveEncoder(p);
        if (p.proposalType === appDataUpdateProposalType)
            throw new UsageError("Cannot encode custom proposal with the app_data_update proposal type");
        return proposalCustomEncoder(p);
    }
    switch (p.proposalType) {
        case defaultProposalTypes.add:
            return proposalAddEncoder(p);
        case defaultProposalTypes.update:
            return proposalUpdateEncoder(p);
        case defaultProposalTypes.remove:
            return proposalRemoveEncoder(p);
        case defaultProposalTypes.psk:
            return proposalPSKEncoder(p);
        case defaultProposalTypes.reinit:
            return proposalReinitEncoder(p);
        case defaultProposalTypes.external_init:
            return proposalExternalInitEncoder(p);
        case defaultProposalTypes.group_context_extensions:
            return proposalGroupContextExtensionsEncoder(p);
    }
};
const proposalAddDecoder = mapDecoder(addDecoder, (add) => ({
    proposalType: defaultProposalTypes.add,
    add,
}));
const proposalUpdateDecoder = mapDecoder(updateDecoder, (update) => ({
    proposalType: defaultProposalTypes.update,
    update,
}));
const proposalRemoveDecoder = mapDecoder(removeDecoder, (remove) => ({
    proposalType: defaultProposalTypes.remove,
    remove,
}));
const proposalPSKDecoder = mapDecoder(pskDecoder, (psk) => ({
    proposalType: defaultProposalTypes.psk,
    psk,
}));
const proposalReinitDecoder = mapDecoder(reinitDecoder, (reinit) => ({
    proposalType: defaultProposalTypes.reinit,
    reinit,
}));
const proposalExternalInitDecoder = mapDecoder(externalInitDecoder, (externalInit) => ({
    proposalType: defaultProposalTypes.external_init,
    externalInit,
}));
const proposalGroupContextExtensionsDecoder = mapDecoder(groupContextExtensionsDecoder, (groupContextExtensions) => ({
    proposalType: defaultProposalTypes.group_context_extensions,
    groupContextExtensions,
}));
const proposalAppDataUpdateDecoder = mapDecoder(appDataUpdateDecoder, (appDataUpdate) => ({
    proposalType: appDataUpdateProposalType,
    appDataUpdate,
}));
function proposalCustomDecoder(proposalType) {
    return mapDecoder(varLenDataDecoder, (proposalData) => ({ proposalType, proposalData }));
}
// self_remove has an empty body, so it decodes from zero further bytes.
const proposalSelfRemoveDecoder = succeedDecoder({
    proposalType: selfRemoveProposalType,
});
export const proposalDecoder = orDecoder(flatMapDecoder(decodeDefaultProposalTypeValue, (proposalType) => {
    switch (proposalType) {
        case defaultProposalTypes.add:
            return proposalAddDecoder;
        case defaultProposalTypes.update:
            return proposalUpdateDecoder;
        case defaultProposalTypes.remove:
            return proposalRemoveDecoder;
        case defaultProposalTypes.psk:
            return proposalPSKDecoder;
        case defaultProposalTypes.reinit:
            return proposalReinitDecoder;
        case defaultProposalTypes.external_init:
            return proposalExternalInitDecoder;
        case defaultProposalTypes.group_context_extensions:
            return proposalGroupContextExtensionsDecoder;
    }
}), flatMapDecoder(uint16Decoder, (n) => {
    if (n === appDataUpdateProposalType)
        return proposalAppDataUpdateDecoder;
    if (n === selfRemoveProposalType)
        return proposalSelfRemoveDecoder;
    return proposalCustomDecoder(n);
}));
