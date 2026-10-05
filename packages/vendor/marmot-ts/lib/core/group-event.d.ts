/** @module @category Core - Group Messages */
import { NostrEvent } from "applesauce-core/helpers/event";
import { ClientState, CiphersuiteImpl, type MlsMessage } from "../vendor/ts-mls/index.js";
export type CreateGroupEventOptions = {
    /** The serialized MLS message */
    message: MlsMessage;
    /** The ClientState for the group */
    state: ClientState;
    /** The ciphersuite implementation */
    ciphersuite: CiphersuiteImpl;
    /**
     * NIP-40 `expiration` (Unix seconds). Only for application messages whose
     * source epoch enables message retention; never for commits or proposals.
     */
    expiration?: bigint;
};
/**
 * Creates a Nostr event containing an encrypted MLS message.
 *
 * @param options - The options for creating the event
 * @returns A signed Nostr event
 */
export declare function createGroupEvent(options: CreateGroupEventOptions): Promise<NostrEvent>;
