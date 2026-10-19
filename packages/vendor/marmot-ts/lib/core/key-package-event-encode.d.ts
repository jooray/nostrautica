import { EventTemplate } from "applesauce-core/helpers/event";
import { KeyPackage } from "../vendor/ts-mls/index.js";
export type CreateKeyPackageEventOptions = {
    keyPackage: KeyPackage;
    /**
     * The addressable slot identifier (`d` tag value). Required — callers must
     * supply this; {@link KeyPackageManager} handles defaulting to `clientId` or
     * throwing {@link MissingSlotIdentifierError} when none is available.
     */
    identifier: string;
    /** @deprecated Relay destinations belong to the transport and are never emitted as tags. */
    relays?: string[];
    client?: string;
    /**
     * Whether to include the NIP-70 protected tag (["-"]).
     *
     * The current kind-30443 tag set (`transports/nostr.md`, KeyPackage publication) does not
     * include it, so it is omitted by default; many relays also reject protected events.
     */
    protected?: boolean;
};
/** Require a stable publication slot generated once from 32 random bytes. */
export declare function validateKeyPackageSlot(identifier: string): void;
/**
 * Creates an addressable key package event (kind 30443) from a key package.
 *
 * @param options - The options for creating the key package event
 * @returns The unsigned key package event template
 */
export declare function createKeyPackageEvent(options: CreateKeyPackageEventOptions): Promise<EventTemplate>;
