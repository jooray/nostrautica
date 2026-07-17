/** @module @category Core - Relay Lists */
import { NostrEvent, UnsignedEvent } from "applesauce-core/helpers/event";
/** Optional NIP-65 read/write marker on an `r` tag. */
export type Nip65RelayUsage = "read" | "write";
/**
 * Reads relay URLs from a NIP-65 (kind 10002) relay-list event.
 *
 * Each entry is an `r` tag: `["r", url]` (both read and write) or
 * `["r", url, "read" | "write"]`. Pass `usage` to keep only relays usable for
 * that direction; omit it to return every advertised relay (markerless `r`
 * tags count as both directions).
 *
 * @param event - The kind 10002 event
 * @param usage - Optional direction filter
 * @returns Normalized, validated relay URLs
 */
export declare function getNip65Relays(event: NostrEvent, usage?: Nip65RelayUsage): string[];
/** True for a kind 10002 event that advertises at least one valid relay. */
export declare function isValidNip65RelayListEvent(event: NostrEvent): boolean;
/** Options for {@link createNip65RelayListEvent}. */
export type CreateNip65RelayListEventOptions = {
    /** The pubkey of the event author */
    pubkey: string;
    /** The relays the account publishes and fetches KeyPackages from */
    relays: string[];
    /** Optional NIP-65 marker applied to every relay (omit for read+write) */
    usage?: Nip65RelayUsage;
};
/**
 * Creates an unsigned NIP-65 (kind 10002) relay-list event. Marmot reads this
 * list to discover an account's KeyPackage relays.
 */
export declare function createNip65RelayListEvent(options: CreateNip65RelayListEventOptions): UnsignedEvent;
/**
 * Reads relay URLs from an inbox (kind 10050) relay-list event. Each entry is a
 * `relay` tag: `["relay", url]`.
 */
export declare function getInboxRelays(event: NostrEvent): string[];
/** True for a kind 10050 event that advertises at least one valid relay. */
export declare function isValidInboxRelayListEvent(event: NostrEvent): boolean;
/** Options for {@link createInboxRelayListEvent}. */
export type CreateInboxRelayListEventOptions = {
    /** The pubkey of the event author */
    pubkey: string;
    /** The relays where the account receives gift-wrapped welcomes */
    relays: string[];
};
/**
 * Creates an unsigned inbox (kind 10050) relay-list event. Marmot reads this
 * list to learn where to deliver a recipient's welcomes.
 */
export declare function createInboxRelayListEvent(options: CreateInboxRelayListEventOptions): UnsignedEvent;
