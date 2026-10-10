import { uint32Encoder, uint32Decoder } from "./codec/number.js";
import { optionalEncoder, optionalDecoder } from "./codec/optional.js";
import { mapDecoders, flatMapDecoder } from "./codec/tlsDecoder.js";
import { contramapBufferEncoders, encode } from "./codec/tlsEncoder.js";
import { varLenDataEncoder, varLenDataDecoder } from "./codec/variableLength.js";
import { leafNodeEncoder, leafNodeDecoder } from "./leafNode.js";
import { InternalError } from "./mlsError.js";
import { nodeTypeDecoder, nodeTypeEncoder, nodeTypes } from "./nodeType.js";
import { parentNodeEncoder, parentNodeDecoder } from "./parentNode.js";
import { rootFromNodeWidth, isLeaf, nodeToLeafIndex, left, right } from "./treemath.js";
const leafNodeHashInputEncoder = contramapBufferEncoders([nodeTypeEncoder, uint32Encoder, optionalEncoder(leafNodeEncoder)], (input) => [input.nodeType, input.leafIndex, input.leafNode]);
const leafNodeHashInputDecoder = mapDecoders([uint32Decoder, optionalDecoder(leafNodeDecoder)], (leafIndex, leafNode) => ({
    nodeType: nodeTypes.leaf,
    leafIndex,
    leafNode,
}));
const parentNodeHashInputEncoder = contramapBufferEncoders([nodeTypeEncoder, optionalEncoder(parentNodeEncoder), varLenDataEncoder, varLenDataEncoder], (input) => [input.nodeType, input.parentNode, input.leftHash, input.rightHash]);
const parentNodeHashInputDecoder = mapDecoders([optionalDecoder(parentNodeDecoder), varLenDataDecoder, varLenDataDecoder], (parentNode, leftHash, rightHash) => ({
    nodeType: nodeTypes.parent,
    parentNode,
    leftHash,
    rightHash,
}));
export const treeHashInputEncoder = (input) => {
    switch (input.nodeType) {
        case nodeTypes.leaf:
            return leafNodeHashInputEncoder(input);
        case nodeTypes.parent:
            return parentNodeHashInputEncoder(input);
    }
};
export const treeHashInputDecoder = flatMapDecoder(nodeTypeDecoder, (nodeType) => {
    switch (nodeType) {
        case nodeTypes.leaf:
            return leafNodeHashInputDecoder;
        case nodeTypes.parent:
            return parentNodeHashInputDecoder;
    }
});
export async function treeHashRoot(tree, h, mutableTreeHashCache) {
    return treeHash(tree, rootFromNodeWidth(tree.length), h, mutableTreeHashCache);
}
export async function treeHash(tree, subtreeIndex, h, mutableTreeHashCache) {
    if (mutableTreeHashCache !== undefined) {
        const cached = mutableTreeHashCache[subtreeIndex];
        if (cached !== undefined)
            return cached;
    }
    let result;
    if (isLeaf(subtreeIndex)) {
        const leafNode = tree[subtreeIndex];
        if (leafNode?.nodeType === nodeTypes.parent)
            throw new InternalError("Somehow found parent node in leaf position");
        const input = encode(leafNodeHashInputEncoder, {
            nodeType: nodeTypes.leaf,
            leafIndex: nodeToLeafIndex(subtreeIndex),
            leafNode: leafNode?.leaf,
        });
        result = await h.digest(input);
    }
    else {
        const parentNode = tree[subtreeIndex];
        if (parentNode?.nodeType === nodeTypes.leaf)
            throw new InternalError("Somehow found leaf node in parent position");
        const leftHash = await treeHash(tree, left(subtreeIndex), h, mutableTreeHashCache);
        const rightHash = await treeHash(tree, right(subtreeIndex), h, mutableTreeHashCache);
        const input = {
            nodeType: nodeTypes.parent,
            parentNode: parentNode?.parent,
            leftHash: leftHash,
            rightHash: rightHash,
        };
        result = await h.digest(encode(parentNodeHashInputEncoder, input));
    }
    if (mutableTreeHashCache !== undefined)
        mutableTreeHashCache[subtreeIndex] = result;
    return result;
}
