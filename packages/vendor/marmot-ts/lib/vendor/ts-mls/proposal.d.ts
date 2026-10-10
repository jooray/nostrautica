import { Decoder } from "./codec/tlsDecoder.js";
import { Encoder } from "./codec/tlsEncoder.js";
import { GroupContextExtension } from "./extension.js";
import { KeyPackage } from "./keyPackage.js";
import { PskId } from "./presharedkey.js";
import { defaultProposalTypes } from "./defaultProposalType.js";
import { ProtocolVersionValue } from "./protocolVersion.js";
import { LeafNodeUpdate } from "./leafNode.js";
import { AppDataUpdate, appDataUpdateProposalType } from "./appDataUpdate.js";
import { selfRemoveProposalType } from "./selfRemove.js";
/** @public */
export interface Add {
    keyPackage: KeyPackage;
}
export declare const addEncoder: Encoder<Add>;
export declare const addDecoder: Decoder<Add>;
/** @public */
export interface Update {
    leafNode: LeafNodeUpdate;
}
export declare const updateEncoder: Encoder<Update>;
export declare const updateDecoder: Decoder<Update>;
/** @public */
export interface Remove {
    removed: number;
}
export declare const removeEncoder: Encoder<Remove>;
export declare const removeDecoder: Decoder<Remove>;
/** @public */
export interface PSK {
    preSharedKeyId: PskId;
}
export declare const pskEncoder: Encoder<PSK>;
export declare const pskDecoder: Decoder<PSK>;
/** @public */
export interface Reinit {
    groupId: Uint8Array;
    version: ProtocolVersionValue;
    cipherSuite: number;
    extensions: GroupContextExtension[];
}
export declare const reinitEncoder: Encoder<Reinit>;
export declare const reinitDecoder: Decoder<Reinit>;
/** @public */
export interface ExternalInit {
    kemOutput: Uint8Array;
}
export declare const externalInitEncoder: Encoder<ExternalInit>;
export declare const externalInitDecoder: Decoder<ExternalInit>;
/** @public */
export interface GroupContextExtensions {
    extensions: GroupContextExtension[];
}
export declare const groupContextExtensionsEncoder: Encoder<GroupContextExtensions>;
export declare const groupContextExtensionsDecoder: Decoder<GroupContextExtensions>;
/** @public */
export interface ProposalAdd {
    proposalType: typeof defaultProposalTypes.add;
    add: Add;
}
/** @public */
export interface ProposalUpdate {
    proposalType: typeof defaultProposalTypes.update;
    update: Update;
}
/** @public */
export interface ProposalRemove {
    proposalType: typeof defaultProposalTypes.remove;
    remove: Remove;
}
/** @public */
export interface ProposalPSK {
    proposalType: typeof defaultProposalTypes.psk;
    psk: PSK;
}
/** @public */
export interface ProposalReinit {
    proposalType: typeof defaultProposalTypes.reinit;
    reinit: Reinit;
}
/** @public */
export interface ProposalExternalInit {
    proposalType: typeof defaultProposalTypes.external_init;
    externalInit: ExternalInit;
}
/** @public */
export interface ProposalGroupContextExtensions {
    proposalType: typeof defaultProposalTypes.group_context_extensions;
    groupContextExtensions: GroupContextExtensions;
}
/**
 * The `app_data_update` proposal defined in draft-ietf-mls-extensions-09. Updates the
 * `app_data_dictionary` GroupContext extension when committed.
 *
 * @public
 */
export interface ProposalAppDataUpdate {
    proposalType: typeof appDataUpdateProposalType;
    appDataUpdate: AppDataUpdate;
}
/**
 * The `self_remove` proposal defined in draft-ietf-mls-extensions. The body is
 * empty — the leaving member is the proposal's MLS sender — so it MUST be
 * committed by reference (preserving the sender) by another member.
 *
 * @public
 */
export interface ProposalSelfRemove {
    proposalType: typeof selfRemoveProposalType;
}
/** @public */
export interface ProposalCustom {
    proposalType: number;
    proposalData: Uint8Array;
}
/** @public */
export type DefaultProposal = ProposalAdd | ProposalUpdate | ProposalRemove | ProposalPSK | ProposalReinit | ProposalExternalInit | ProposalGroupContextExtensions;
/** @public */
export type Proposal = DefaultProposal | ProposalAppDataUpdate | ProposalSelfRemove | ProposalCustom;
/** @public */
export declare function isDefaultProposal(p: Proposal): p is DefaultProposal;
/** @public */
export declare function isAppDataUpdateProposal(p: Proposal): p is ProposalAppDataUpdate;
/** @public */
export declare function isSelfRemoveProposal(p: Proposal): p is ProposalSelfRemove;
/** @public */
export declare function isCustomProposal(p: Proposal): p is ProposalCustom;
export declare const proposalEncoder: Encoder<Proposal>;
export declare const proposalDecoder: Decoder<Proposal>;
