/** @module @category Core - Group Messages */
import { NostrEvent } from "applesauce-core/helpers/event";
import { ClientState, CiphersuiteImpl, type MlsMessage } from "ts-mls";
export type CreateGroupEventOptions = {
    /** The serialized MLS message */
    message: MlsMessage;
    /** The ClientState for the group */
    state: ClientState;
    /** The ciphersuite implementation */
    ciphersuite: CiphersuiteImpl;
};
/**
 * Creates a Nostr event containing an encrypted MLS message.
 *
 * @param options - The options for creating the event
 * @returns A signed Nostr event
 */
export declare function createGroupEvent(options: CreateGroupEventOptions): Promise<NostrEvent>;
