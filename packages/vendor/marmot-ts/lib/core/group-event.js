/** @module @category Core - Group Messages */
import { finalizeEvent } from "applesauce-core/helpers/event";
import { generateSecretKey } from "applesauce-core/helpers/keys";
import { unixNow } from "../utils/nostr.js";
import { getNostrGroupIdHex } from "./client-state.js";
import { nostrTransportBinding } from "./transport.js";
import { createEncryptedGroupEventContent } from "./group-message-crypto.js";
/**
 * Creates a Nostr event containing an encrypted MLS message.
 *
 * @param options - The options for creating the event
 * @returns A signed Nostr event
 */
export async function createGroupEvent(options) {
    const { message, state, ciphersuite, expiration } = options;
    const content = await createEncryptedGroupEventContent({
        state,
        ciphersuite,
        message,
    });
    const groupId = getNostrGroupIdHex(state);
    const draft = {
        kind: nostrTransportBinding.groupMessageKind,
        created_at: unixNow(),
        content,
        tags: [[nostrTransportBinding.groupIdTag, groupId]],
    };
    if (expiration !== undefined)
        draft.tags.push(["expiration", expiration.toString()]);
    // Ephemeral keypair for signing — distinct from the encryption keypair (`transports/nostr.md`: fresh per-event ephemeral key)
    const ephemeralSecretKey = generateSecretKey();
    return finalizeEvent(draft, ephemeralSecretKey);
}
