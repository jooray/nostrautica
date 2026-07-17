/** @module @category Core - Transport */
import { ADDRESSABLE_KEY_PACKAGE_KIND, GROUP_EVENT_KIND, INBOX_RELAY_LIST_KIND, NIP65_RELAY_LIST_KIND, WELCOME_EVENT_KIND, } from "./protocol.js";
/** The Nostr group routing tag (`h`) naming the public nostr group id. */
export const NOSTR_GROUP_ID_TAG = "h";
/** NIP-59 gift-wrap event kind used to wrap a Welcome for its recipient. */
export const GIFT_WRAP_KIND = 1059;
/**
 * The Nostr transport binding: the default (and currently only) Marmot delivery
 * binding. All kinds and the routing tag are gathered here so the transport
 * seam is explicit and a future binding can mirror the shape.
 */
export const nostrTransportBinding = {
    name: "nostr",
    groupMessageKind: GROUP_EVENT_KIND,
    welcomeKind: WELCOME_EVENT_KIND,
    addressableKeyPackageKind: ADDRESSABLE_KEY_PACKAGE_KIND,
    nip65RelayListKind: NIP65_RELAY_LIST_KIND,
    inboxRelayListKind: INBOX_RELAY_LIST_KIND,
    giftWrapKind: GIFT_WRAP_KIND,
    groupIdTag: NOSTR_GROUP_ID_TAG,
};
//# sourceMappingURL=transport.js.map