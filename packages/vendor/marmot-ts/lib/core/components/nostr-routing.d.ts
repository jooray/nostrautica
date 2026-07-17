export interface NostrRoutingV1 {
    nostrGroupId: Uint8Array;
    relays: string[];
}
/** Encodes a {@link NostrRoutingV1} to its component `data` bytes. */
export declare function encodeNostrRoutingV1(routing: NostrRoutingV1): Uint8Array;
/** Decodes `marmot.transport.nostr.routing.v1` component `data` bytes. */
export declare function decodeNostrRoutingV1(data: Uint8Array): NostrRoutingV1;
