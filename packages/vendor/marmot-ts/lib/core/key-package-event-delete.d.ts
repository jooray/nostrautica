/** @module @category Core - Key Package Event */
import { EventTemplate, NostrEvent } from "applesauce-core/helpers/event";
export type DeleteKeyPackageEventInput = string | NostrEvent;
export type CreateDeleteKeyPackageEventOptions = {
    /** List of event ids (or full events) to delete */
    events: DeleteKeyPackageEventInput[];
};
/**
 * Creates a NIP-09 delete event (kind 5) to delete one or more KeyPackage
 * events (kind 30443).
 *
 * Both an `e` tag (event id) and an `a` tag (addressable coordinate) are
 * included so relays can match either way. String-only inputs produce only an
 * `e` tag since no pubkey/d is available.
 */
export declare function createDeleteKeyPackageEvent(options: CreateDeleteKeyPackageEventOptions): EventTemplate;
