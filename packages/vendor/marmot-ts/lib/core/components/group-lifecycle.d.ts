/** Protocol lifecycle values carried by `marmot.group.lifecycle.v1`. */
export declare const groupProtocolLifecycleValues: {
    readonly active: "active";
    readonly disbanded: "disbanded";
};
export type GroupProtocolLifecycleValue = (typeof groupProtocolLifecycleValues)[keyof typeof groupProtocolLifecycleValues];
/** Encodes the lifecycle state as its exact one-byte wire value. */
export declare function encodeGroupLifecycleV1(value: GroupProtocolLifecycleValue): Uint8Array;
/** Decodes an exact one-byte `marmot.group.lifecycle.v1` value. */
export declare function decodeGroupLifecycleV1(data: Uint8Array): GroupProtocolLifecycleValue;
