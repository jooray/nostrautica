/**
 * Maximum number of relays in a routing state (`nostr-routing-v1.md`
 * "Validation": "the relay list contains at most 16 entries"). MDK enforces the
 * same bound on encode and decode (`NOSTR_ROUTING_MAX_RELAYS` in
 * `traits/src/app_components/routing.rs`) and caps the Welcome `relays` tag at
 * 16, so a larger list is rejected by every MDK member.
 */
export declare const NOSTR_ROUTING_MAX_RELAYS = 16;
export interface NostrRoutingV1 {
    nostrGroupId: Uint8Array;
    relays: string[];
}
/** Encodes a {@link NostrRoutingV1} to its component `data` bytes. */
export declare function encodeNostrRoutingV1(routing: NostrRoutingV1): Uint8Array;
/** Decodes `marmot.transport.nostr.routing.v1` component `data` bytes. */
export declare function decodeNostrRoutingV1(data: Uint8Array): NostrRoutingV1;
