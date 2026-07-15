import { EventTemplate } from "applesauce-core/helpers/event";
import { KeyPackage } from "ts-mls";
export type CreateKeyPackageEventOptions = {
    keyPackage: KeyPackage;
    /**
     * The addressable slot identifier (`d` tag value). Required — callers must
     * supply this; {@link KeyPackageManager} handles defaulting to `clientId` or
     * throwing {@link MissingSlotIdentifierError} when none is available.
     */
    identifier: string;
    /** Relay URLs to advertise in the event */
    relays?: string[];
    client?: string;
    /**
     * Whether to include the NIP-70 protected tag (["-"]).
     *
     * Per MIP-00 this SHOULD be omitted by default because many relays reject
     * protected events.
     */
    protected?: boolean;
};
/**
 * Creates an addressable key package event (kind 30443) from a key package.
 *
 * @param options - The options for creating the key package event
 * @returns The unsigned key package event template
 */
export declare function createKeyPackageEvent(options: CreateKeyPackageEventOptions): Promise<EventTemplate>;
