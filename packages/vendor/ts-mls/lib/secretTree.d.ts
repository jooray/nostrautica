import { Decoder } from "./codec/tlsDecoder.js";
import { Encoder } from "./codec/tlsEncoder.js";
import { ContentTypeValue } from "./contentType.js";
import { CiphersuiteImpl } from "./crypto/ciphersuite.js";
import { KeyRetentionConfig } from "./keyRetentionConfig.js";
import { ReuseGuard, SenderData } from "./sender.js";
import { LeafIndex } from "./treemath.js";
/** @public */
export interface GenerationSecret {
    secret: Uint8Array;
    generation: number;
    unusedGenerations: Record<number, Uint8Array>;
}
/** @public */
export interface SecretTreeNode {
    handshake: GenerationSecret;
    application: GenerationSecret;
}
/** @public */
export interface SecretTree {
    leafWidth: number;
    intermediateNodes: Record<number, Uint8Array>;
    leafNodes: Record<number, SecretTreeNode>;
}
export declare const secretTreeEncoder: Encoder<SecretTree>;
export declare const secretTreeDecoder: Decoder<SecretTree>;
export declare function appendSecretTreeValues(tree: SecretTree, out: Uint8Array[]): void;
interface ConsumeRatchetResult {
    nonce: Uint8Array;
    reuseGuard: ReuseGuard;
    key: Uint8Array;
    generation: number;
    newTree: SecretTree;
    consumed: Uint8Array[];
}
export declare function createSecretTree(leafWidth: number, encryptionSecret: Uint8Array): SecretTree;
export declare function ratchetToGeneration(tree: SecretTree, senderData: SenderData, contentType: ContentTypeValue, config: KeyRetentionConfig, cs: CiphersuiteImpl): Promise<ConsumeRatchetResult>;
export declare function consumeRatchet(tree: SecretTree, index: LeafIndex, contentType: ContentTypeValue, cs: CiphersuiteImpl): Promise<ConsumeRatchetResult>;
export {};
