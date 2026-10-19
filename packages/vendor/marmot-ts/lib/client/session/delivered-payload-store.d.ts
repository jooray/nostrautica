/** @module @category Client - Session */
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { DeliveredAppPayload } from "../../engine/delivered-payloads.js";
import type { GroupHistoryTree } from "../../engine/history-tree.js";
export type DeliveredEvidence = {
    entries: DeliveredAppPayload<NostrEvent>[];
    pending: DeliveredAppPayload<NostrEvent>[];
};
/** No epoch secrets: only already-delivered payloads and their provenance. */
export declare function encodeDeliveredEvidence(evidence: DeliveredEvidence): Uint8Array;
/** Reject corrupt records rather than invent identity or branch attribution. */
export declare function decodeDeliveredEvidence(bytes: Uint8Array, tree: GroupHistoryTree): DeliveredEvidence;
