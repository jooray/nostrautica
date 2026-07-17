import type { AppComponentId } from "./ids.js";
/**
 * Codec for the upstream `app_components` component (`0x0001`) `data` payload:
 * the sorted, unique list of component ids a member supports (in a LeafNode) or
 * a group requires (in the GroupContext).
 *
 * Wire (Marmot binary profile):
 *   ComponentID component_ids<V>;   // QUIC-varint byte length, then be-uint16 ids
 *
 * Ids are encoded ascending and MUST be unique.
 *
 * @see darkmatter `crates/traits/src/app_components.rs` `encode_components_list`
 */
/** Encodes a set of component ids to the `app_components` data payload. */
export declare function encodeComponentsList(ids: Iterable<AppComponentId>): Uint8Array;
/** Decodes an `app_components` data payload into a sorted, unique id list. */
export declare function decodeComponentsList(data: Uint8Array): AppComponentId[];
