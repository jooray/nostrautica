/** @module @category Core - Group Members */
import { defaultCredentialTypes, getGroupMembers as getMlsGroupMembers, nodeTypes, } from "ts-mls";
import { getCredentialPubkey, isSameCredential } from "./credential.js";
function nodeToLeafIndex(nodeIndex) {
    // This matches ts-mls treemath: nodeToLeafIndex(nodeIndex) = nodeIndex / 2
    // for leaf positions in the ratchet tree.
    return Math.floor(nodeIndex / 2);
}
/** Gets all the nostr pubkey keys in a group */
export function getGroupMembers(state) {
    const pubkeys = new Set();
    for (const leaf of getMlsGroupMembers(state)) {
        if (leaf.credential.credentialType === defaultCredentialTypes.basic) {
            pubkeys.add(getCredentialPubkey(leaf.credential));
        }
    }
    return Array.from(pubkeys);
}
/** Gets all leaf nodes for a given nostr pubkey in a group */
export function getPubkeyLeafNodes(state, pubkey) {
    return state.ratchetTree
        .filter((node) => node?.nodeType === nodeTypes.leaf)
        .filter((node) => node.leaf.credential.credentialType === defaultCredentialTypes.basic &&
        getCredentialPubkey(node.leaf.credential) === pubkey)
        .map((node) => node.leaf);
}
/**
 * Gets all leaf node indexes for a given nostr pubkey in a group.
 *
 * @param state - The ClientState to search
 * @param pubkey - The nostr pubkey to find
 * @returns Array of leaf node indexes (numbers) for the given pubkey
 */
export function getPubkeyLeafNodeIndexes(state, pubkey) {
    const leafIndexes = [];
    for (let nodeIndex = 0; nodeIndex < state.ratchetTree.length; nodeIndex++) {
        const node = state.ratchetTree[nodeIndex];
        if (node &&
            node.nodeType === nodeTypes.leaf &&
            node.leaf.credential.credentialType === defaultCredentialTypes.basic) {
            if (getCredentialPubkey(node.leaf.credential) === pubkey)
                leafIndexes.push(Number(nodeToLeafIndex(nodeIndex)));
        }
    }
    return leafIndexes;
}
/**
 * Gets all leaf node indexes for a given credential in a group.
 *
 * @param state - The ClientState to search
 * @param credential - The credential to find
 * @returns Array of leaf node indexes (numbers) for the given credential
 */
export function getCredentialLeafNodeIndexes(state, credential) {
    const leafIndexes = [];
    for (let nodeIndex = 0; nodeIndex < state.ratchetTree.length; nodeIndex++) {
        const node = state.ratchetTree[nodeIndex];
        if (node && node.nodeType === nodeTypes.leaf) {
            if (isSameCredential(node.leaf.credential, credential))
                leafIndexes.push(Number(nodeToLeafIndex(nodeIndex)));
        }
    }
    return leafIndexes;
}
//# sourceMappingURL=group-members.js.map