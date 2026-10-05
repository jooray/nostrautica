import { addHistoricalReceiverData, makePskIndex, throwIfDefined, validateRatchetTree } from "./clientState.js";
import { applyProposals, nextEpochContext, exportSecret, checkCanSendHandshakeMessages, } from "./clientState.js";
import { protocolVersions } from "./protocolVersion.js";
import { decryptWithLabel } from "./crypto/hpke.js";
import { createContentCommitSignature, createConfirmationTag, } from "./framedContent.js";
import { contentTypes } from "./contentType.js";
import { senderTypes } from "./sender.js";
import { groupContextEncoder } from "./groupContext.js";
import { ratchetTreeFromExtension, signGroupInfo, verifyGroupInfoSignature, } from "./groupInfo.js";
import { makeKeyPackageRef } from "./keyPackage.js";
import { initializeEpoch } from "./keySchedule.js";
import { protect } from "./messageProtection.js";
import { protectPublicMessage } from "./messageProtectionPublic.js";
import { getCommitSecret, pathToPathSecrets } from "./pathSecrets.js";
import { mergePrivateKeyPaths, updateLeafKey, toPrivateKeyPath } from "./privateKeyPath.js";
import { defaultProposalTypes } from "./defaultProposalType.js";
import { defaultExtensionTypes } from "./defaultExtensionType.js";
import { proposalOrRefTypes } from "./proposalOrRefType.js";
import { nodeTypes } from "./nodeType.js";
import { ratchetTreeEncoder, getCredentialFromLeafIndex, getSignaturePublicKeyFromLeafIndex, removeLeafNodeMutable, addLeafNodeMutable, } from "./ratchetTree.js";
import { createSecretTree } from "./secretTree.js";
import { treeHashRoot } from "./treeHash.js";
import { directPath, leafToNodeIndex, leafWidth, nodeToLeafIndex, toLeafIndex, toNodeIndex, } from "./treemath.js";
import { createUpdatePath, firstCommonAncestor, firstMatchAncestor } from "./updatePath.js";
import { base64ToBytes, zeroOutUint8Array } from "./util/byteArray.js";
import { encryptGroupInfo, encryptGroupSecrets } from "./welcome.js";
import { CryptoVerificationError, InternalError, UsageError, ValidationError } from "./mlsError.js";
import { resolveClientConfig } from "./clientConfig.js";
import { extensionsSupportedByCapabilities } from "./extension.js";
import { encode } from "./codec/tlsEncoder.js";
import { wireformats } from "./wireformat.js";
export async function createCommitInternal(params) {
    const { context, state, resumingFromState: pskState, ...options } = params;
    const { cipherSuite } = context;
    const pskIndex = makePskIndex(pskState ?? state, context.externalPsks ?? {});
    const clientConfig = resolveClientConfig(context.clientConfig);
    const { wireAsPublicMessage = false, extraProposals = [], ratchetTreeExtension = false, authenticatedData = new Uint8Array(), groupInfoExtensions = [], } = options;
    checkCanSendHandshakeMessages(state);
    const wireformat = wireAsPublicMessage ? "mls_public_message" : "mls_private_message";
    const allProposals = bundleAllProposals(state, extraProposals);
    const mutableTree = state.ratchetTree.slice();
    const res = await applyProposals(state, mutableTree, allProposals, toLeafIndex(state.privatePath.leafIndex), pskIndex, true, clientConfig, context.authService, cipherSuite);
    if (res.additionalResult.kind === "externalCommit")
        throw new UsageError("Cannot create externalCommit as a member");
    const suspendedPendingReinit = res.additionalResult.kind === "reinit" ? res.additionalResult.reinit : undefined;
    const touchedLeaves = res.needsUpdatePath
        ? [...res.updatedLeaves, ...res.removedLeaves, toLeafIndex(state.privatePath.leafIndex)]
        : [...res.updatedLeaves, ...res.removedLeaves];
    const treeHashCache = deriveTreeHashCache(mutableTree.length, state.treeHashCache, touchedLeaves);
    const updatedExtensions = res.additionalResult.kind === "memberCommit" && res.additionalResult.extensions !== undefined
        ? res.additionalResult.extensions
        : state.groupContext.extensions;
    const groupContextWithExtensions = { ...state.groupContext, extensions: updatedExtensions };
    const excludeNodes = res.additionalResult.kind === "memberCommit"
        ? res.additionalResult.addedLeafNodes.map(([leafIndex]) => leafToNodeIndex(leafIndex))
        : [];
    const [tree, updatePath, pathSecrets, newPrivateKey, precomputedTreeHash] = res.needsUpdatePath
        ? await createUpdatePath(mutableTree, toLeafIndex(state.privatePath.leafIndex), groupContextWithExtensions, state.signaturePrivateKey, cipherSuite, treeHashCache, excludeNodes)
        : [mutableTree, undefined, [], undefined, undefined];
    const privateKeys = mergePrivateKeyPaths(newPrivateKey !== undefined
        ? updateLeafKey(state.privatePath, await cipherSuite.hpke.exportPrivateKey(newPrivateKey))
        : state.privatePath, await toPrivateKeyPath(pathToPathSecrets(pathSecrets), state.privatePath.leafIndex, cipherSuite));
    const lastPathSecret = pathSecrets.at(-1);
    const commitSecret = lastPathSecret === undefined
        ? new Uint8Array(cipherSuite.kdf.size)
        : await getCommitSecret(tree, toNodeIndex(lastPathSecret.nodeIndex), lastPathSecret.secret, cipherSuite.kdf);
    const { signature, framedContent } = await createContentCommitSignature(state.groupContext, wireformat, { proposals: allProposals, path: updatePath }, { senderType: senderTypes.member, leafIndex: state.privatePath.leafIndex }, authenticatedData, state.signaturePrivateKey, cipherSuite.signature);
    const treeHash = precomputedTreeHash ?? (await treeHashRoot(tree, cipherSuite.hash, treeHashCache));
    const updatedGroupContext = await nextEpochContext(groupContextWithExtensions, wireformat, framedContent, signature, treeHash, state.confirmationTag, cipherSuite.hash);
    const epochSecrets = await initializeEpoch(state.keySchedule.initSecret, commitSecret, updatedGroupContext, res.pskSecret, cipherSuite.kdf);
    const confirmationTag = await createConfirmationTag(epochSecrets.keySchedule.confirmationKey, updatedGroupContext.confirmedTranscriptHash, cipherSuite.hash);
    const authData = {
        contentType: framedContent.contentType,
        signature,
        confirmationTag,
    };
    const [commit, _newTree, consumedSecrets] = await protectCommit(wireAsPublicMessage, state, clientConfig, authenticatedData, framedContent, authData, cipherSuite);
    const welcome = await createWelcome(ratchetTreeExtension, updatedGroupContext, confirmationTag, state, tree, cipherSuite, epochSecrets, res, pathSecrets, groupInfoExtensions);
    const groupActiveState = res.selfRemoved
        ? { kind: "removedFromGroup" }
        : suspendedPendingReinit !== undefined
            ? { kind: "suspendedPendingReinit", reinit: suspendedPendingReinit }
            : { kind: "active" };
    const [historicalReceiverData, consumedEpochData] = addHistoricalReceiverData(state, clientConfig);
    const newState = {
        groupContext: updatedGroupContext,
        ratchetTree: tree,
        secretTree: createSecretTree(leafWidth(tree.length), epochSecrets.encryptionSecret),
        keySchedule: epochSecrets.keySchedule,
        privatePath: privateKeys,
        unappliedProposals: {},
        historicalReceiverData,
        confirmationTag,
        signaturePrivateKey: state.signaturePrivateKey,
        groupActiveState,
        treeHashCache,
    };
    zeroOutUint8Array(commitSecret);
    zeroOutUint8Array(epochSecrets.joinerSecret);
    const consumed = [...consumedSecrets, ...consumedEpochData, state.keySchedule.initSecret];
    const mlsWelcome = welcome
        ? { welcome, wireformat: wireformats.mls_welcome, version: protocolVersions.mls10 }
        : undefined;
    return { newState, welcome: mlsWelcome, commit, consumed };
}
/** @public */
export async function createCommit(params) {
    return createCommitInternal(params);
}
function bundleAllProposals(state, extraProposals) {
    const refs = Object.keys(state.unappliedProposals).map((p) => ({
        proposalOrRefType: proposalOrRefTypes.reference,
        reference: base64ToBytes(p),
    }));
    const proposals = extraProposals.map((p) => ({
        proposalOrRefType: proposalOrRefTypes.proposal,
        proposal: p,
    }));
    return [...refs, ...proposals];
}
async function createWelcome(ratchetTreeExtension, groupContext, confirmationTag, state, tree, cs, epochSecrets, res, pathSecrets, extensions) {
    const groupInfo = ratchetTreeExtension
        ? await createGroupInfoWithRatchetTree(groupContext, confirmationTag, state, tree, extensions, cs)
        : await createGroupInfo(groupContext, confirmationTag, state, extensions, cs);
    const encryptedGroupInfo = await encryptGroupInfo(groupInfo, epochSecrets.welcomeSecret, cs);
    const encryptedGroupSecrets = res.additionalResult.kind === "memberCommit"
        ? await Promise.all(res.additionalResult.addedLeafNodes.map(([leafNodeIndex, keyPackage]) => {
            return createEncryptedGroupSecrets(tree, leafNodeIndex, state, pathSecrets, cs, keyPackage, encryptedGroupInfo, epochSecrets, res);
        }))
        : [];
    return encryptedGroupSecrets.length > 0
        ? {
            cipherSuite: groupContext.cipherSuite,
            secrets: encryptedGroupSecrets,
            encryptedGroupInfo,
        }
        : undefined;
}
async function createEncryptedGroupSecrets(tree, leafNodeIndex, state, pathSecrets, cs, keyPackage, encryptedGroupInfo, epochSecrets, res) {
    const nodeIndex = firstCommonAncestor(tree, leafNodeIndex, toLeafIndex(state.privatePath.leafIndex));
    const pathSecret = pathSecrets.find((ps) => ps.nodeIndex === nodeIndex);
    const pk = await cs.hpke.importPublicKey(keyPackage.initKey);
    const egs = await encryptGroupSecrets(pk, encryptedGroupInfo, { joinerSecret: epochSecrets.joinerSecret, pathSecret: pathSecret?.secret, psks: res.pskIds }, cs.hpke);
    const ref = await makeKeyPackageRef(keyPackage, cs.hash);
    return { newMember: ref, encryptedGroupSecrets: { kemOutput: egs.enc, ciphertext: egs.ct } };
}
async function createGroupInfo(groupContext, confirmationTag, state, extensions, cs) {
    const groupInfoTbs = {
        groupContext: groupContext,
        extensions: extensions,
        confirmationTag,
        signer: state.privatePath.leafIndex,
    };
    return signGroupInfo(groupInfoTbs, state.signaturePrivateKey, cs.signature);
}
async function createGroupInfoWithRatchetTree(groupContext, confirmationTag, state, tree, extensions, cs) {
    const gi = await createGroupInfo(groupContext, confirmationTag, state, [
        ...extensions,
        { extensionType: defaultExtensionTypes.ratchet_tree, extensionData: encode(ratchetTreeEncoder, tree) },
    ], cs);
    return gi;
}
/** @public */
export async function createGroupInfoWithExternalPub(state, extensions, cs) {
    const externalKeyPair = await cs.hpke.deriveKeyPair(state.keySchedule.externalSecret);
    const externalPub = await cs.hpke.exportPublicKey(externalKeyPair.publicKey);
    const gi = await createGroupInfo(state.groupContext, state.confirmationTag, state, [...extensions, { extensionType: defaultExtensionTypes.external_pub, extensionData: externalPub }], cs);
    return gi;
}
/** @public */
export async function createGroupInfoWithExternalPubAndRatchetTree(state, extensions, cs) {
    const encodedTree = encode(ratchetTreeEncoder, state.ratchetTree);
    const externalKeyPair = await cs.hpke.deriveKeyPair(state.keySchedule.externalSecret);
    const externalPub = await cs.hpke.exportPublicKey(externalKeyPair.publicKey);
    const gi = await createGroupInfo(state.groupContext, state.confirmationTag, state, [
        ...extensions,
        { extensionType: defaultExtensionTypes.external_pub, extensionData: externalPub },
        { extensionType: defaultExtensionTypes.ratchet_tree, extensionData: encodedTree },
    ], cs);
    return gi;
}
async function protectCommit(publicMessage, state, clientConfig, authenticatedData, content, authData, cs) {
    const wireformat = publicMessage ? wireformats.mls_public_message : wireformats.mls_private_message;
    const authenticatedContent = {
        wireformat,
        content,
        auth: authData,
    };
    if (publicMessage) {
        const msg = await protectPublicMessage(state.keySchedule.membershipKey, state.groupContext, authenticatedContent, cs);
        return [
            { version: protocolVersions.mls10, wireformat: wireformats.mls_public_message, publicMessage: msg },
            state.secretTree,
            [],
        ];
    }
    else {
        const res = await protect(state.keySchedule.senderDataSecret, authenticatedData, state.groupContext, state.secretTree, { ...content, auth: authData }, state.privatePath.leafIndex, clientConfig.paddingConfig, cs);
        return [
            {
                version: protocolVersions.mls10,
                wireformat: wireformats.mls_private_message,
                privateMessage: res.privateMessage,
            },
            res.tree,
            res.consumed,
        ];
    }
}
export async function applyUpdatePathSecret(tree, privatePath, senderLeafIndex, gc, path, excludeNodes, cs) {
    const { nodeIndex: ancestorNodeIndex, resolution, updateNode, } = firstMatchAncestor(tree, toLeafIndex(privatePath.leafIndex), senderLeafIndex, path);
    for (const [i, nodeIndex] of filterNewLeaves(resolution, excludeNodes).entries()) {
        if (privatePath.privateKeys[nodeIndex] !== undefined) {
            const key = await cs.hpke.importPrivateKey(privatePath.privateKeys[nodeIndex]);
            const ct = updateNode.encryptedPathSecret[i];
            const pathSecret = await decryptWithLabel(key, "UpdatePathNode", encode(groupContextEncoder, gc), ct.kemOutput, ct.ciphertext, cs.hpke);
            return { nodeIndex: ancestorNodeIndex, pathSecret };
        }
    }
    throw new InternalError("No overlap between provided private keys and update path");
}
/** @public */
export async function joinGroupExternal(params) {
    const context = params.context;
    const groupInfo = params.groupInfo;
    const keyPackage = params.keyPackage;
    const privateKeys = params.privateKeys;
    const resync = params.resync;
    const authService = context.authService;
    const cs = context.cipherSuite;
    const clientConfig = resolveClientConfig(context.clientConfig);
    const tree = params.tree;
    const authenticatedData = params.authenticatedData ?? new Uint8Array();
    const externalPub = groupInfo.extensions.find((ex) => ex.extensionType === defaultExtensionTypes.external_pub);
    if (externalPub === undefined)
        throw new UsageError("Could not find external_pub extension");
    const allExtensionsSupported = extensionsSupportedByCapabilities(groupInfo.groupContext.extensions, keyPackage.leafNode.capabilities);
    if (!allExtensionsSupported)
        throw new UsageError("client does not support every extension in the GroupContext");
    const { enc, secret: initSecret } = await exportSecret(externalPub.extensionData, cs);
    //copy tree if not
    const ratchetTree = ratchetTreeFromExtension(groupInfo) ?? tree?.slice();
    if (ratchetTree === undefined)
        throw new UsageError("No RatchetTree passed and no ratchet_tree extension");
    const mutableTree = ratchetTree;
    throwIfDefined(await validateRatchetTree(ratchetTree, groupInfo.groupContext, clientConfig.lifetimeConfig, authService, groupInfo.groupContext.treeHash, cs));
    const signaturePublicKey = getSignaturePublicKeyFromLeafIndex(ratchetTree, toLeafIndex(groupInfo.signer));
    const signerCredential = getCredentialFromLeafIndex(ratchetTree, toLeafIndex(groupInfo.signer));
    const credentialVerified = await authService.validateCredential(signerCredential, signaturePublicKey);
    if (!credentialVerified)
        throw new ValidationError("Could not validate credential");
    const groupInfoSignatureVerified = await verifyGroupInfoSignature(groupInfo, signaturePublicKey, cs.signature);
    if (!groupInfoSignatureVerified)
        throw new CryptoVerificationError("Could not verify groupInfo Signature");
    let formerLeafIndex;
    if (resync) {
        const idx = ratchetTree.findIndex((n) => n !== undefined &&
            n.nodeType === nodeTypes.leaf &&
            clientConfig.keyPackageEqualityConfig.compareKeyPackageToLeafNode(keyPackage, n.leaf));
        if (idx < 0)
            throw new ValidationError("External join with resync: no prior leaf matching the new KeyPackage");
        formerLeafIndex = nodeToLeafIndex(toNodeIndex(idx));
        removeLeafNodeMutable(mutableTree, formerLeafIndex);
    }
    const newLeafNodeIndex = addLeafNodeMutable(mutableTree, keyPackage.leafNode);
    const externalTreeHashCache = [];
    const [newTree, updatePath, pathSecrets, newPrivateKey, precomputedTreeHash] = await createUpdatePath(mutableTree, nodeToLeafIndex(newLeafNodeIndex), groupInfo.groupContext, privateKeys.signaturePrivateKey, cs, externalTreeHashCache);
    const privateKeyPath = updateLeafKey(await toPrivateKeyPath(pathToPathSecrets(pathSecrets), nodeToLeafIndex(newLeafNodeIndex), cs), await cs.hpke.exportPrivateKey(newPrivateKey));
    const lastPathSecret = pathSecrets.at(-1);
    const commitSecret = lastPathSecret === undefined
        ? new Uint8Array(cs.kdf.size)
        : await getCommitSecret(newTree, toNodeIndex(lastPathSecret.nodeIndex), lastPathSecret.secret, cs.kdf);
    const externalInitProposal = {
        proposalType: defaultProposalTypes.external_init,
        externalInit: { kemOutput: enc },
    };
    const proposals = formerLeafIndex !== undefined
        ? [{ proposalType: defaultProposalTypes.remove, remove: { removed: formerLeafIndex } }, externalInitProposal]
        : [externalInitProposal];
    const pskSecret = new Uint8Array(cs.kdf.size);
    const { signature, framedContent } = await createContentCommitSignature(groupInfo.groupContext, "mls_public_message", {
        proposals: proposals.map((p) => ({ proposalOrRefType: proposalOrRefTypes.proposal, proposal: p })),
        path: updatePath,
    }, {
        senderType: senderTypes.new_member_commit,
    }, authenticatedData, privateKeys.signaturePrivateKey, cs.signature);
    const treeHash = precomputedTreeHash;
    const groupContext = await nextEpochContext(groupInfo.groupContext, "mls_public_message", framedContent, signature, treeHash, groupInfo.confirmationTag, cs.hash);
    const epochSecrets = await initializeEpoch(initSecret, commitSecret, groupContext, pskSecret, cs.kdf);
    const confirmationTag = await createConfirmationTag(epochSecrets.keySchedule.confirmationKey, groupContext.confirmedTranscriptHash, cs.hash);
    const state = {
        ratchetTree: newTree,
        groupContext: groupContext,
        secretTree: createSecretTree(leafWidth(newTree.length), epochSecrets.encryptionSecret),
        privatePath: privateKeyPath,
        confirmationTag,
        historicalReceiverData: new Map(),
        signaturePrivateKey: privateKeys.signaturePrivateKey,
        keySchedule: epochSecrets.keySchedule,
        unappliedProposals: {},
        groupActiveState: { kind: "active" },
        treeHashCache: externalTreeHashCache,
    };
    const authenticatedContent = {
        content: framedContent,
        auth: { signature, confirmationTag, contentType: contentTypes.commit },
        wireformat: wireformats.mls_public_message,
    };
    const msg = await protectPublicMessage(epochSecrets.keySchedule.membershipKey, groupContext, authenticatedContent, cs);
    zeroOutUint8Array(commitSecret);
    zeroOutUint8Array(initSecret);
    zeroOutUint8Array(epochSecrets.joinerSecret);
    return {
        commit: { publicMessage: msg, wireformat: wireformats.mls_public_message, version: protocolVersions.mls10 },
        newState: state,
    };
}
function filterNewLeaves(resolution, excludeNodes) {
    const set = new Set(excludeNodes);
    return resolution.filter((i) => !set.has(i));
}
export function deriveTreeHashCache(newLen, oldCache, touchedLeaves) {
    const cache = oldCache.slice(0, newLen);
    if (cache.length < newLen)
        cache.length = newLen;
    const newLeafWidth = leafWidth(newLen);
    for (const leaf of touchedLeaves) {
        if (leaf >= newLeafWidth)
            continue;
        const leafNode = leafToNodeIndex(leaf);
        cache[leafNode] = undefined;
        for (const anc of directPath(leafNode, newLeafWidth))
            cache[anc] = undefined;
    }
    return cache;
}
