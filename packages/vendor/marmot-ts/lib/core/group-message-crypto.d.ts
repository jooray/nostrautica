/** @module @category Core - Group Messages */
import { NostrEvent } from "applesauce-core/helpers/event";
import { ClientState, CiphersuiteImpl, type MlsMessage } from "ts-mls";
/**
 * Reads a {@link NostrEvent} and returns the {@link MlsMessage} it contains.
 * Decrypts group-event encrypted content using the exporter_secret from the group state.
 *
 * @param message - The Nostr event containing the encrypted MLS message
 * @param clientState - The ClientState for the group (to get exporter_secret)
 * @param ciphersuite - The ciphersuite implementation
 * @returns The decoded MlsMessage
 */
export declare function decryptGroupMessageEvent(message: NostrEvent, clientState: ClientState, ciphersuite: CiphersuiteImpl): Promise<MlsMessage>;
/**
 * Encrypts the content of a group event using MIP-03.
 *
 * @returns The encrypted content
 */
export declare function createEncryptedGroupEventContent({ state, ciphersuite, message, }: {
    /** The ClientState for the group (to get exporter_secret) */
    state: ClientState;
    /** The ciphersuite implementation */
    ciphersuite: CiphersuiteImpl;
    /** The MLS message to encrypt */
    message: MlsMessage;
}): Promise<string>;
export type GroupMessagePair = {
    event: NostrEvent;
    message: MlsMessage;
};
/**
 * Decrypts a kind 445 event and returns the {@link MlsMessage} it contains.
 *
 * @param event - The Nostr event containing the encrypted MLS message
 * @param clientState - The ClientState for the group (to get exporter_secret)
 * @param ciphersuite - The ciphersuite implementation
 * @returns The event and the decoded MlsMessage
 */
export declare function decryptGroupMessage(event: NostrEvent, clientState: ClientState, ciphersuite: CiphersuiteImpl): Promise<GroupMessagePair>;
/**
 * Decrypts multiple kind 445 events and returns the {@link MlsMessage} they contain.
 *
 * @param events - The Nostr events containing the encrypted MLS messages
 * @param clientState - The ClientState for the group (to get exporter_secret)
 * @param ciphersuite - The ciphersuite implementation
 * @returns An array of event and decoded MlsMessage pairs
 */
export declare function decryptGroupMessages(events: NostrEvent[], clientState: ClientState, ciphersuite: CiphersuiteImpl): Promise<{
    read: GroupMessagePair[];
    unreadable: NostrEvent[];
}>;
