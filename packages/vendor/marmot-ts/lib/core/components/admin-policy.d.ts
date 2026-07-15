/** Encodes a list of admin x-only pubkeys (64-char hex) to component `data`. */
export declare function encodeAdminPolicyV1(adminPubkeys: string[]): Uint8Array;
/** Decodes `marmot.group.admin-policy.v1` component `data` bytes to hex keys. */
export declare function decodeAdminPolicyV1(data: Uint8Array): string[];
