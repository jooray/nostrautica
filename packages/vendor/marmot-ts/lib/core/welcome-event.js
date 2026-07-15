/** @module @category Core - Welcome */
import { isRumor } from "applesauce-common/helpers/gift-wrap";
import { getEventHash, getTagValue } from "applesauce-core/helpers/event";
import { decode, encode, mlsMessageDecoder, mlsMessageEncoder, protocolVersions, wireformats, } from "ts-mls";
import { decodeContent, encodeContent } from "../utils/encoding.js";
import { unixNow } from "../utils/nostr.js";
import { WELCOME_EVENT_KIND } from "./protocol.js";
/** True when `value` is a 32-byte (64-char) lowercase-or-uppercase hex string. */
function isEventId(value) {
    return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}
/**
 * Creates a welcome rumor (kind 444) for a welcome message.
 *
 * @returns Welcome rumor with precomputed ID
 */
export function createWelcomeRumor({ welcome, author, groupRelays, keyPackageEventId, }) {
    if (!isEventId(keyPackageEventId))
        throw new Error("Welcome rumor requires a 32-byte hex KeyPackage event id (e tag)");
    if (groupRelays.length === 0 || groupRelays.some((r) => r.length === 0))
        throw new Error("Welcome rumor requires a non-empty relays tag with no empty relay URLs");
    // Serialize the welcome message as a full MLSMessage (RFC 9420)
    const mlsMessage = {
        version: protocolVersions.mls10,
        wireformat: wireformats.mls_welcome,
        welcome,
    };
    const serializedWelcome = encode(mlsMessageEncoder, mlsMessage);
    const content = encodeContent(serializedWelcome, "base64");
    // No `encoding` tag: the spec forbids it and content is always standard
    // base64 (transports/nostr.md "Transport byte encoding"). The `e` tag is
    // mandatory and validated above.
    const draft = {
        kind: WELCOME_EVENT_KIND,
        pubkey: author,
        created_at: unixNow(),
        content,
        tags: [
            ["relays", ...groupRelays],
            ["e", keyPackageEventId],
        ],
    };
    // Calculate the event ID for the rumor
    const id = getEventHash(draft);
    return {
        ...draft,
        id,
    };
}
/** Returns the key package event ID from a welcome rumor */
export function getWelcomeKeyPackageEventId(event) {
    return getTagValue(event, "e");
}
/** Returns the group relays from a welcome rumor */
export function getWelcomeGroupRelays(event) {
    // NOTE: The "relays" tag is a normal Nostr tag vector: ["relays", ...urls]
    // (see transports/nostr.md "Welcome delivery" and createWelcomeRumor()).
    const tag = event.tags.find((t) => t[0] === "relays");
    if (!tag)
        return [];
    return tag.slice(1);
}
/**
 * Returns the KeyPackageRefs of the intended recipients from a Welcome message.
 *
 * Each entry in `welcome.secrets` contains a plaintext `newMember` field which
 * is the RFC 9420 KeyPackageRef (a hash of the recipient's KeyPackage). No
 * decryption is required to read these.
 *
 * @param welcome - The MLS Welcome message
 * @returns Array of KeyPackageRefs (one per recipient)
 */
export function getWelcomeKeyPackageRefs(welcome) {
    // Unwrap welcome rumor if provided
    if (isRumor(welcome))
        welcome = getWelcome(welcome);
    return welcome.secrets.map((s) => s.newMember);
}
/**
 * Gets the Welcome message from a kind 444 event.
 *
 * @param event - The Nostr event containing the welcome message
 * @returns The decoded Welcome message
 * @throws Error if the content cannot be decoded
 */
export function getWelcome(event) {
    if (event.kind !== WELCOME_EVENT_KIND)
        throw new Error(`Expected welcome event kind ${WELCOME_EVENT_KIND}, got ${event.kind}`);
    // Validate the transport-level rumor shape the spec mandates before decoding
    // (transports/nostr.md "Welcome delivery"): a 32-byte-hex `e` tag and a
    // non-empty `relays` tag with no empty relay URLs.
    const keyPackageEventId = getTagValue(event, "e");
    if (!isEventId(keyPackageEventId))
        throw new Error("Invalid welcome event: missing or malformed e tag (expected 32-byte hex KeyPackage event id)");
    const relays = getWelcomeGroupRelays(event);
    if (relays.length === 0 || relays.some((r) => r.length === 0))
        throw new Error("Invalid welcome event: relays tag must contain at least one non-empty relay URL");
    // Content is always standard base64; the spec forbids an `encoding` tag.
    const content = decodeContent(event.content, "base64");
    const mlsMessage = decode(mlsMessageDecoder, content);
    if (!mlsMessage)
        throw new Error("Failed to decode welcome message");
    if (mlsMessage.wireformat !== wireformats.mls_welcome)
        throw new Error(`Expected MLSMessage with mls_welcome wireformat, got wireformat ${mlsMessage.wireformat}`);
    return mlsMessage.welcome;
}
//# sourceMappingURL=welcome-event.js.map