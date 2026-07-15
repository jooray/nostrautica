/** @module @category Client - Key Package Manager */
import { NostrEvent } from "applesauce-core/helpers/event";
/**
 * Computes the replaceable-event coordinate (`kind:pubkey:d`) for a kind-30443
 * key package event, or `undefined` when the event carries no slot identifier.
 */
export declare function getReplaceableEventKey(event: NostrEvent): string | undefined;
/**
 * Deduplicates a list of published kind-30443 events.
 *
 * Drops exact duplicate event ids, then collapses replaceable events that share
 * the same `kind:pubkey:d` coordinate down to the newest by `created_at`.
 * Non-addressable events (no slot identifier) are kept as-is.
 */
export declare function deduplicatePublishedEvents(events: NostrEvent[]): NostrEvent[];
