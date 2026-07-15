import { Decoder } from "./codec/tlsDecoder.js";
import { Encoder } from "./codec/tlsEncoder.js";
/** @public */
export declare const nodeTypes: {
    readonly leaf: 1;
    readonly parent: 2;
};
type NodeTypeValue = (typeof nodeTypes)[keyof typeof nodeTypes];
export declare const nodeTypeEncoder: Encoder<NodeTypeValue>;
export declare const nodeTypeDecoder: Decoder<NodeTypeValue>;
export {};
