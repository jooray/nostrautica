/** @module @category Client - Key Package Manager */
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { PublishResponse } from "./nostr-interface.js";
/**
 * No requested relay acknowledged a KeyPackage publication or deletion.
 * Responses retain rejection/uncertainty details; the signed event is provided
 * for inspection. This error does not imply that no relay observed the event.
 */
export declare class KeyPackagePublishError extends Error {
    readonly event: NostrEvent;
    readonly relays: string[];
    readonly responses: Record<string, PublishResponse>;
    constructor(event: NostrEvent, relays: string[], responses: Record<string, PublishResponse>);
}
/**
 * Thrown by {@link KeyPackageManager.create} when no relay URLs are provided.
 * Callers can catch this specifically to prompt the user for relay configuration.
 */
export declare class MissingRelayError extends Error {
    constructor();
}
/**
 * Thrown by {@link KeyPackageManager.create} when no slot identifier (`d` tag)
 * can be determined — neither passed in options nor set as `clientId` on the
 * manager. Set `clientId` on the manager or pass `d` in the options.
 */
export declare class MissingSlotIdentifierError extends Error {
    constructor();
}
/**
 * Thrown by {@link KeyPackageManager.rotate} when the given key package
 * reference is not found in the local store.
 */
export declare class KeyPackageNotFoundError extends Error {
    constructor(refHex: string);
}
/**
 * Thrown by {@link KeyPackageManager.rotate} when no relay URLs can be
 * determined for the replacement key package — neither passed explicitly
 * nor recoverable from the old package's local publication routes.
 */
export declare class KeyPackageRotatePreconditionError extends Error {
    constructor();
}
