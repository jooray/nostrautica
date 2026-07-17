import { Capabilities } from "./capabilities.js";
import { Decoder } from "./codec/tlsDecoder.js";
import { Encoder } from "./codec/tlsEncoder.js";
import { Credential } from "./credential.js";
import { Signature } from "./crypto/signature.js";
import { LeafNodeExtension } from "./extension.js";
import { leafNodeSources } from "./leafNodeSource.js";
import { Lifetime } from "./lifetime.js";
/** @public */
export interface LeafNodeData {
    hpkePublicKey: Uint8Array;
    signaturePublicKey: Uint8Array;
    credential: Credential;
    capabilities: Capabilities;
}
export declare const leafNodeDataEncoder: Encoder<LeafNodeData>;
export declare const leafNodeDataDecoder: Decoder<LeafNodeData>;
/** @public */
export type LeafNodeInfoOmitted = LeafNodeInfoKeyPackage | LeafNodeInfoUpdateOmitted | LeafNodeInfoCommitOmitted;
/** @public */
export interface LeafNodeInfoUpdateOmitted {
    leafNodeSource: typeof leafNodeSources.update;
    extensions: LeafNodeExtension[];
}
/** @public */
export interface LeafNodeInfoCommitOmitted {
    leafNodeSource: typeof leafNodeSources.commit;
    parentHash: Uint8Array;
    extensions: LeafNodeExtension[];
}
/** @public */
export interface LeafNodeInfoKeyPackage {
    leafNodeSource: typeof leafNodeSources.key_package;
    lifetime: Lifetime;
    extensions: LeafNodeExtension[];
}
type LeafNodeInfoUpdate = LeafNodeInfoUpdateOmitted & {
    groupId: Uint8Array;
    leafIndex: number;
};
type LeafNodeInfoCommit = LeafNodeInfoCommitOmitted & {
    groupId: Uint8Array;
    leafIndex: number;
};
export type LeafNodeTBSCommit = LeafNodeData & LeafNodeInfoCommit;
export type LeafNodeTBSUpdate = LeafNodeData & LeafNodeInfoUpdate;
export type LeafNodeTBSKeyPackage = LeafNodeData & LeafNodeInfoKeyPackage;
/** @public */
export type LeafNode = LeafNodeData & LeafNodeInfoOmitted & {
    signature: Uint8Array;
};
export declare const leafNodeEncoder: Encoder<LeafNode>;
export declare const leafNodeDecoder: Decoder<LeafNode>;
/** @public */
export type LeafNodeKeyPackage = LeafNode & {
    leafNodeSource: typeof leafNodeSources.key_package;
};
export declare const leafNodeKeyPackageDecoder: Decoder<LeafNodeKeyPackage>;
/** @public */
export type LeafNodeCommit = LeafNode & {
    leafNodeSource: typeof leafNodeSources.commit;
};
export declare const leafNodeCommitDecoder: Decoder<LeafNodeCommit>;
/** @public */
export type LeafNodeUpdate = LeafNode & {
    leafNodeSource: typeof leafNodeSources.update;
};
export declare const leafNodeUpdateDecoder: Decoder<LeafNodeUpdate>;
export declare function signLeafNodeCommit(tbs: LeafNodeTBSCommit, signaturePrivateKey: Uint8Array, sig: Signature): Promise<LeafNodeCommit>;
export declare function signLeafNodeKeyPackage(tbs: LeafNodeTBSKeyPackage, signaturePrivateKey: Uint8Array, sig: Signature): Promise<LeafNodeKeyPackage>;
export declare function signLeafNodeUpdate(tbs: LeafNodeTBSUpdate, signaturePrivateKey: Uint8Array, sig: Signature): Promise<LeafNodeUpdate>;
export declare function verifyLeafNodeSignature(leaf: LeafNode, groupId: Uint8Array, leafIndex: number, sig: Signature): Promise<boolean>;
export declare function verifyLeafNodeSignatureKeyPackage(leaf: LeafNodeKeyPackage, sig: Signature): Promise<boolean>;
export declare function leafNodeEqual(a: LeafNode, b: LeafNode): boolean;
export {};
