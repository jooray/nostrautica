import { checkCanSendApplicationMessages, getOwnLeafNode, processProposal } from "./clientState.js";
import { signLeafNodeUpdate } from "./leafNode.js";
import { leafNodeSources } from "./leafNodeSource.js";
import { protectProposal, protectApplicationData } from "./messageProtection.js";
import { protectProposalPublic } from "./messageProtectionPublic.js";
import { defaultProposalTypes } from "./defaultProposalType.js";
import { selfRemoveProposalType } from "./selfRemove.js";
import { addUnappliedProposal } from "./unappliedProposals.js";
import { protocolVersions } from "./protocolVersion.js";
import { wireformats } from "./wireformat.js";
import { resolveClientConfig } from "./clientConfig.js";
import { InternalError } from "./mlsError.js";
/** @public */
export async function createProposal(params) {
    const context = params.context;
    const state = params.state;
    const cs = context.cipherSuite;
    const ad = params.authenticatedData ?? new Uint8Array();
    const clientConfig = resolveClientConfig(context.clientConfig);
    const publicMessage = params.wireAsPublicMessage ?? false;
    const proposal = params.proposal;
    if (publicMessage) {
        const result = await protectProposalPublic(state.signaturePrivateKey, state.keySchedule.membershipKey, state.groupContext, ad, proposal, state.privatePath.leafIndex, cs);
        const newState = await processProposal(state, {
            content: result.publicMessage.content,
            auth: result.publicMessage.auth,
            wireformat: wireformats.mls_public_message,
        }, proposal, cs.hash);
        return {
            newState,
            message: {
                wireformat: wireformats.mls_public_message,
                version: protocolVersions.mls10,
                publicMessage: result.publicMessage,
            },
            consumed: [],
        };
    }
    else {
        const result = await protectProposal(state.signaturePrivateKey, state.keySchedule.senderDataSecret, proposal, ad, state.groupContext, state.secretTree, state.privatePath.leafIndex, clientConfig.paddingConfig, cs);
        const newState = {
            ...state,
            secretTree: result.newSecretTree,
            unappliedProposals: addUnappliedProposal(result.proposalRef, state.unappliedProposals, proposal, state.privatePath.leafIndex),
        };
        return {
            newState,
            message: {
                wireformat: wireformats.mls_private_message,
                version: protocolVersions.mls10,
                privateMessage: result.privateMessage,
            },
            consumed: result.consumed,
        };
    }
}
/**
 * Creates a `self_remove` proposal: the caller proposes their own removal for
 * another member to commit. Framed as a PublicMessage (draft-ietf-mls-extensions
 * / MIP-03) so the leaving member is the recorded MLS sender and the proposal can
 * be committed by reference. The committer cannot be the sender (RFC 9420 §12.2),
 * so this proposal advances no epoch on its own.
 *
 * @public
 */
export async function createSelfRemoveProposal(params) {
    return createProposal({
        context: params.context,
        state: params.state,
        wireAsPublicMessage: true,
        proposal: { proposalType: selfRemoveProposalType },
        authenticatedData: params.authenticatedData,
    });
}
/** @public */
export async function createUpdateProposal(params) {
    const { context, state } = params;
    const cs = context.cipherSuite;
    const ownLeaf = getOwnLeafNode(state);
    if (ownLeaf === undefined)
        throw new InternalError("No own leaf node found for update proposal");
    const leafSecret = cs.rng.randomBytes(cs.kdf.size);
    const leafKeypair = await cs.hpke.deriveKeyPair(leafSecret);
    const hpkePublicKey = await cs.hpke.exportPublicKey(leafKeypair.publicKey);
    const hpkePrivateKey = await cs.hpke.exportPrivateKey(leafKeypair.privateKey);
    const tbs = {
        leafNodeSource: leafNodeSources.update,
        hpkePublicKey,
        signaturePublicKey: ownLeaf.signaturePublicKey,
        credential: ownLeaf.credential,
        capabilities: ownLeaf.capabilities,
        extensions: params.leafNodeExtensions ?? ownLeaf.extensions,
        groupId: state.groupContext.groupId,
        leafIndex: state.privatePath.leafIndex,
    };
    const leafNode = await signLeafNodeUpdate(tbs, state.signaturePrivateKey, cs.signature);
    const proposal = {
        proposalType: defaultProposalTypes.update,
        update: { leafNode },
    };
    const result = await createProposal({
        context,
        state,
        wireAsPublicMessage: params.wireAsPublicMessage,
        authenticatedData: params.authenticatedData,
        proposal,
    });
    return { ...result, newLeafKeypair: { hpkePublicKey, hpkePrivateKey } };
}
/** @public */
export async function createApplicationMessage(params) {
    const context = params.context;
    const state = params.state;
    const cs = context.cipherSuite;
    const ad = params.authenticatedData ?? new Uint8Array();
    const clientConfig = resolveClientConfig(context.clientConfig);
    const message = params.message;
    checkCanSendApplicationMessages(state);
    const result = await protectApplicationData(state.signaturePrivateKey, state.keySchedule.senderDataSecret, message, ad, state.groupContext, state.secretTree, state.privatePath.leafIndex, clientConfig.paddingConfig, cs);
    return {
        newState: { ...state, secretTree: result.newSecretTree },
        message: {
            version: protocolVersions.mls10,
            wireformat: wireformats.mls_private_message,
            privateMessage: result.privateMessage,
        },
        consumed: result.consumed,
    };
}
