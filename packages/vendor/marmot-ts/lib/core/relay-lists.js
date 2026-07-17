import { isValidRelayUrl, normalizeRelayUrl } from "../utils/relay-url.js";
import { INBOX_RELAY_LIST_KIND, INBOX_RELAY_TAG, NIP65_RELAY_LIST_KIND, NIP65_RELAY_TAG, } from "./protocol.js";
import { unixNow } from "../utils/nostr.js";
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
export function getNip65Relays(event, usage) {
    return event.tags
        .filter((tag) => tag[0] === NIP65_RELAY_TAG && tag[1])
        .filter((tag) => {
        if (!usage)
            return true;
        const marker = tag[2];
        // A markerless `r` tag means the relay is used for both read and write.
        return !marker || marker === usage;
    })
        .map((tag) => tag[1])
        .filter(isValidRelayUrl)
        .map(normalizeRelayUrl);
}
/** True for a kind 10002 event that advertises at least one valid relay. */
export function isValidNip65RelayListEvent(event) {
    return (event.kind === NIP65_RELAY_LIST_KIND && getNip65Relays(event).length > 0);
}
/**
 * Creates an unsigned NIP-65 (kind 10002) relay-list event. Marmot reads this
 * list to discover an account's KeyPackage relays.
 */
export function createNip65RelayListEvent(options) {
    const { pubkey, relays, usage } = options;
    const validRelays = relays.filter(isValidRelayUrl).map(normalizeRelayUrl);
    const tags = validRelays.map((relay) => usage ? [NIP65_RELAY_TAG, relay, usage] : [NIP65_RELAY_TAG, relay]);
    return {
        kind: NIP65_RELAY_LIST_KIND,
        created_at: unixNow(),
        tags,
        content: "",
        pubkey,
    };
}
// ---------------------------------------------------------------------------
// Inbox relay list (kind 10050) — Welcome delivery
//
// Welcomes are gift-wrapped to the recipient's inbox relay set
// (transports/nostr.md "Publish targets and acknowledgements").
// ---------------------------------------------------------------------------
/**
 * Reads relay URLs from an inbox (kind 10050) relay-list event. Each entry is a
 * `relay` tag: `["relay", url]`.
 */
export function getInboxRelays(event) {
    return event.tags
        .filter((tag) => tag[0] === INBOX_RELAY_TAG && tag[1])
        .map((tag) => tag[1])
        .filter(isValidRelayUrl)
        .map(normalizeRelayUrl);
}
/** True for a kind 10050 event that advertises at least one valid relay. */
export function isValidInboxRelayListEvent(event) {
    return (event.kind === INBOX_RELAY_LIST_KIND && getInboxRelays(event).length > 0);
}
/**
 * Creates an unsigned inbox (kind 10050) relay-list event. Marmot reads this
 * list to learn where to deliver a recipient's welcomes.
 */
export function createInboxRelayListEvent(options) {
    const { pubkey, relays } = options;
    const validRelays = relays.filter(isValidRelayUrl).map(normalizeRelayUrl);
    const tags = validRelays.map((relay) => [INBOX_RELAY_TAG, relay]);
    return {
        kind: INBOX_RELAY_LIST_KIND,
        created_at: unixNow(),
        tags,
        content: "",
        pubkey,
    };
}
//# sourceMappingURL=relay-lists.js.map