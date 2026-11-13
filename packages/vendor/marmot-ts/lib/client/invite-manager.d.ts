import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { EventSigner } from "applesauce-core/factories";
import { kinds, KnownEvent, type NostrEvent } from "applesauce-core/helpers/event";
import { EventEmitter } from "eventemitter3";
import type { GenericKeyValueStore } from "../utils/key-value.js";
import type { NostrNetworkInterface, Unsubscribable } from "./nostr-interface.js";
import { type RejectReason, type VerifyEventMethod } from "./verify.js";
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
    /** Written before prompting; automatic listening never retries an attempt. */
    attempted?: boolean;
    /** Validated transition journal; survives a failed unread write or cleanup. */
    rumor?: UnreadInvite;
    /** Permanently invalid plaintext; only source cleanup remains. */
    invalid?: boolean;
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
    /** Emitted when a received gift wrap is retired or permanently quarantined */
    processed: (inviteId: string) => void;
    /** Emitted when an event fails to decrypt or parse */
    error: (error: Error, eventId: string) => void;
    /**
     * Emitted when an inbound kind-1059 gift wrap is rejected at the trust
     * boundary — before it is stored or decrypted — for an invalid outer
     * signature (SEC-01) or a repeated/absent/empty required `p` tag
     * (WIRE-02). Client/manager scope: no group context applies here.
     */
    rejected: (event: NostrEvent, reason: RejectReason) => void;
};
export interface InviteManagerOptions {
    /** Signer for decrypting gift wraps */
    signer: EventSigner;
    /** Storage backend for invite entries */
    store: GenericKeyValueStore<StoredInviteEntry>;
    /** The nostr relay pool, used by {@link InviteManager.listen}. */
    network: NostrNetworkInterface;
    /**
     * Injectable Nostr event verifier gating the outer kind-1059 gift wrap
     * before it is stored or decrypted (SEC-01). Defaults to applesauce's
     * `verifyEvent`. `unlockGiftWrap` only verifies the inner seal — this gate
     * closes that gap by verifying the outer event itself.
     */
    verifyEvent?: VerifyEventMethod;
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
 * - `received:<eventId>` keys hold gift wraps and optional retry/transition state
 * - `unread:<rumorId>` keys hold decrypted welcome rumors
 */
export declare class InviteManager extends EventEmitter<InviteManagerEvents> {
    #private;
    private signer;
    private store;
    private network;
    private seenCache;
    private readonly unreadRecovery;
    private processing;
    constructor(options: InviteManagerOptions);
    /**
     * Subscribes for gift-wrapped invites (kind 1059) addressed to this account on
     * the given relays — the inbound counterpart the app would otherwise hand-wire.
     * Each new gift wrap is {@link ingestEvent | ingested} (de-duplicated) and then
     * {@link decryptGiftWraps | decrypted}, so `watchUnread` / the `decrypted` event
     * update on their own. Previously unattempted gift wraps are tried once on
     * start. Failed/interrupted attempts require an explicit decrypt call, even
     * after reconnect or restart; journaled transitions resume without prompting.
     * Call `.unsubscribe()` on the result to stop listening.
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
     * - On success: journals the validated rumor, persists unread, then retires received.
     * - Signer/cancellation/storage failures emit 'error' and retain the source.
     * - Invalid decrypted payloads are retired (or quarantined until cleanup succeeds).
     *
     * This is an explicit retry, which may prompt the signer again. A journaled
     * rumor is resumed without prompting or emitting a duplicate 'decrypted' event.
     *
     * @param eventId - The gift wrap event ID to decrypt, or the gift wrap event itself
     * @returns A newly persisted unread rumor, or null on failure/already delivered
     * @throws Error if an event ID is not found in received storage
     */
    decryptGiftWrap(eventId: string | ReceivedGiftWrap): Promise<UnreadInvite | null>;
    private serialize;
    private processGiftWrap;
    /**
     * Decrypts all received gift wraps.
     *
     * Attempts to decrypt and parse each received gift wrap.
     * - On success: moves to 'unread' state and emits 'decrypted'.
     * - On retryable failure: emits 'error' and retains received for explicit retry.
     *
     * This method prompts the user via signer for each decryption,
     * so it should be called deliberately by the app (not automatically).
     *
     * @returns Array of successfully decrypted welcome rumors
     */
    decryptGiftWraps(): Promise<UnreadInvite[]>;
    private decryptStoredGiftWraps;
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
     * whenever the unread list changes or a recovery confirms persisted unread.
     *
     * This does NOT automatically mark invites as read - the app must
     * call markAsRead() after processing each invite.
     *
     * Pass an AbortSignal to stop watching. Abort, return, throw, and async
     * disposal release listeners and interrupt pending reads without another event.
     * Abandoned reads may finish internally; their results are ignored.
     */
    watchUnread(options?: {
        signal?: AbortSignal;
    }): AsyncGenerator<UnreadInvite[]>;
    /**
     * Calls `changed` whenever the unread list may have changed.
     * Returns a function that removes the listeners.
     * @internal
     */
    onUnreadChanged(changed: () => void): () => void;
    /**
     * Watch for received (encrypted) invites.
     *
     * Yields the current list of received gift wraps, then yields again
     * whenever the received list changes (via 'received' or 'processed' events).
     *
     * Pass an AbortSignal to stop watching. Abort, return, throw, and async
     * disposal release listeners and interrupt pending reads without another event.
     * Abandoned reads may finish internally; their results are ignored.
     */
    watchReceived(options?: {
        signal?: AbortSignal;
    }): AsyncGenerator<ReceivedGiftWrap[]>;
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
