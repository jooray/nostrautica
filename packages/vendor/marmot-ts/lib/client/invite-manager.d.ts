import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { EventSigner } from "applesauce-core/factories";
import { kinds, KnownEvent, type NostrEvent } from "applesauce-core/helpers/event";
import { EventEmitter } from "eventemitter3";
import type { GenericKeyValueStore } from "../utils/key-value.js";
import type { NostrNetworkInterface, Unsubscribable } from "./nostr-interface.js";
/** A received gift wrap event (kind 1059) that hasn't been decrypted yet */
export interface ReceivedGiftWrap extends KnownEvent<kinds.GiftWrap> {
}
/**
 * A successfully decrypted Welcome rumor (kind 444).
 * All metadata can be derived from the rumor itself.
 */
export interface UnreadInvite extends Rumor {
}
/**
 * Discriminated union for entries stored in the invite store.
 */
export type StoredInviteEntry = {
    type: "seen";
    ids: string[];
} | {
    type: "received";
    giftwrap: ReceivedGiftWrap;
} | {
    type: "unread";
    rumor: UnreadInvite;
};
/**
 * Events emitted by InviteManager
 */
export type InviteManagerEvents = {
    /** Emitted when a gift wrap is ingested and stored */
    received: (invite: ReceivedGiftWrap) => void;
    /** Emitted when an invite is successfully decrypted */
    decrypted: (invite: UnreadInvite) => void;
    /** Emitted when an invite is marked as read and removed */
    read: (inviteId: string) => void;
    /** Emitted when a received gift wrap is processed (decrypted or failed) */
    processed: (inviteId: string) => void;
    /** Emitted when an event fails to decrypt or parse */
    error: (error: Error, eventId: string) => void;
};
export interface InviteManagerOptions {
    /** Signer for decrypting gift wraps */
    signer: EventSigner;
    /** Storage backend for invite entries */
    store: GenericKeyValueStore<StoredInviteEntry>;
    /** The nostr relay pool, used by {@link InviteManager.listen}. */
    network: NostrNetworkInterface;
}
/**
 * InviteManager orchestrates the lifecycle of reading Welcome invites.
 *
 * It takes gift-wrapped events from the app, handles decryption/parsing,
 * persists invites to storage, and provides interfaces for consumption.
 *
 * The app is responsible for:
 * - Syncing events from relays
 * - Passing gift wrap events (kind 1059) to ingestEvent()
 * - Calling decryptGiftWraps() to decrypt (triggers nip-44 decryption prompts)
 * - Reading unread invites via getUnread(), watchUnread(), or event listeners
 * - Marking invites as read after processing
 *
 * State lifecycle:
 * 1. RECEIVED: Gift wrap ingested, stored, awaiting decryption
 * 2. UNREAD: Decrypted and parsed, ready for app consumption
 * 3. SEEN: Event ID tracked to prevent re-processing
 * 4. (DELETED): Read invites are removed from storage
 *
 * Store layout:
 * - `__seen` key holds a serialized set of all seen event IDs
 * - `received:<eventId>` keys hold undecrypted gift wraps
 * - `unread:<rumorId>` keys hold decrypted welcome rumors
 */
export declare class InviteManager extends EventEmitter<InviteManagerEvents> {
    #private;
    private signer;
    private store;
    private network;
    private seenCache;
    constructor(options: InviteManagerOptions);
    /**
     * Subscribes for gift-wrapped invites (kind 1059) addressed to this account on
     * the given relays — the inbound counterpart the app would otherwise hand-wire.
     * Each new gift wrap is {@link ingestEvent | ingested} (de-duplicated) and then
     * {@link decryptGiftWraps | decrypted}, so `watchUnread` / the `decrypted` event
     * update on their own. Any already-stored gift wraps are decrypted once on
     * start. Call `.unsubscribe()` on the result to stop listening.
     *
     * `relays` should be the account's advertised kind-10050 inbox relays — where
     * inviters deliver Welcomes. Subscribing elsewhere silently misses invites.
     */
    listen(relays: string[]): Promise<Unsubscribable>;
    /** Lazily load the seen set from store into memory */
    private getSeenSet;
    /** Persist the in-memory seen set to the store */
    private persistSeen;
    /**
     * Ingest a gift wrap event (kind 1059).
     *
     * The event is checked against the seen index for deduplication.
     * If new, it's stored in the 'received' state awaiting decryption.
     *
     * @param event - Gift wrap event (kind 1059)
     * @returns true if event was new and stored, false if already seen
     * @throws Error if event is not kind 1059
     */
    ingestEvent(event: NostrEvent): Promise<boolean>;
    /**
     * Ingest multiple gift wrap events in batch.
     *
     * @param events - Array of gift wrap events
     * @returns Count of new events stored
     */
    ingestEvents(events: NostrEvent[]): Promise<number>;
    /**
     * Process a single received (undecrypted) gift wrap by event ID.
     *
     * Attempts to decrypt and parse the specified event.
     * - On success: moves to 'unread' state and emits 'newInvite' event
     * - On failure: emits 'error' event (event remains in 'seen' to prevent retry)
     *
     * This method prompts the user via signer for decryption.
     *
     * @param eventId - The gift wrap event ID to decrypt, or the gift wrap event itself
     * @returns The decrypted welcome rumor, or null if failed to decrypt
     * @throws Error if the event is not found in received store
     */
    decryptGiftWrap(eventId: string | ReceivedGiftWrap): Promise<UnreadInvite | null>;
    /**
     * Decrypts all received gift wraps.
     *
     * Attempts to decrypt and parse each received gift wrap.
     * - On success: moves to 'unread' state and emits 'newInvite' event
     * - On failure: emits 'error' event (event remains in 'seen' to prevent retry)
     *
     * This method prompts the user via signer for each decryption,
     * so it should be called deliberately by the app (not automatically).
     *
     * @returns Array of successfully decrypted welcome rumors
     */
    decryptGiftWraps(): Promise<UnreadInvite[]>;
    /**
     * Get all unread invites.
     *
     * @returns Array of unread welcome rumors
     */
    getUnread(): Promise<UnreadInvite[]>;
    /**
     * Get all received (encrypted) invites.
     *
     * @returns Array of received invites awaiting decryption
     */
    getReceived(): Promise<ReceivedGiftWrap[]>;
    /**
     * Mark an invite as read and remove it from storage.
     *
     * Emits 'inviteRead' event after removal.
     *
     * @param inviteId - The rumor ID (from the welcome rumor)
     */
    markAsRead(inviteId: string): Promise<void>;
    /**
     * Watch for unread invites.
     *
     * Yields the current array of unread invites, then yields again
     * whenever the unread list changes (via 'newInvite' or 'inviteRead' events).
     *
     * This does NOT automatically mark invites as read - the app must
     * call markAsRead() after processing each invite.
     */
    watchUnread(): AsyncGenerator<UnreadInvite[]>;
    /**
     * Watch for received (encrypted) invites.
     *
     * Yields the current list of received gift wraps, then yields again
     * whenever the received list changes (via 'ReceivedGiftWrap' or 'receivedProcessed' events).
     */
    watchReceived(): AsyncGenerator<ReceivedGiftWrap[]>;
    /**
     * Clear all stored invites (received and unread).
     *
     * Note: This does NOT clear the seen index to maintain deduplication history.
     * If you need to clear seen events, use clearSeen() or create a fresh store.
     */
    clear(): Promise<void>;
    /**
     * Clear the seen event IDs.
     * Warning: This will allow previously processed events to be re-ingested.
     */
    clearSeen(): Promise<void>;
}
