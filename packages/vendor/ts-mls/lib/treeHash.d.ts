import { Decoder } from "./codec/tlsDecoder.js";
import { Encoder } from "./codec/tlsEncoder.js";
import { Hash } from "./crypto/hash.js";
import { LeafNode } from "./leafNode.js";
import { nodeTypes } from "./nodeType.js";
import { ParentNode } from "./parentNode.js";
import { RatchetTree } from "./ratchetTree.js";
import { NodeIndex } from "./treemath.js";
type TreeHashInput = LeafNodeHashInput | ParentNodeHashInput;
type LeafNodeHashInput = {
    nodeType: typeof nodeTypes.leaf;
    leafIndex: number;
    leafNode: LeafNode | undefined;
};
type ParentNodeHashInput = {
    nodeType: typeof nodeTypes.parent;
    parentNode: ParentNode | undefined;
    leftHash: Uint8Array;
    rightHash: Uint8Array;
};
export declare const treeHashInputEncoder: Encoder<TreeHashInput>;
export declare const treeHashInputDecoder: Decoder<TreeHashInput>;
/** @public */
export type TreeHashCache = (Uint8Array | undefined)[];
export declare function treeHashRoot(tree: RatchetTree, h: Hash, mutableTreeHashCache?: TreeHashCache): Promise<Uint8Array>;
export declare function treeHash(tree: RatchetTree, subtreeIndex: NodeIndex, h: Hash, mutableTreeHashCache?: TreeHashCache): Promise<Uint8Array>;
export {};
