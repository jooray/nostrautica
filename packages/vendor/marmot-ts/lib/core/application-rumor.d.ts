import { Rumor } from "applesauce-common/helpers/gift-wrap";
/**
 * Serializes an application rumor (unsigned Nostr event) to bytes.
 * This is the format used for application messages in Marmot groups.
 *
 * Only the six members a Marmot app event may carry are written
 * (`foundation/application-messages.md` §Encoding), so a signed event or an
 * object with extra fields does not leak a `sig` or unknown member onto the
 * wire. The result is checked with {@link deserializeApplicationData}: a
 * payload every conformant receiver would drop (wrong `id`, non-integer
 * `created_at`, unpaired surrogate in a string, ...) throws here instead of
 * being sent.
 *
 * @param rumor - The unsigned Nostr event to serialize
 * @returns The serialized application data as bytes
 * @throws if the rumor would not decode as a valid Marmot app event
 */
export declare function serializeApplicationRumor(rumor: Rumor): Uint8Array;
/**
 * Deserializes application data bytes back into a rumor, enforcing the Marmot
 * inner-event encoding rules (`foundation/application-messages.md` §Encoding).
 *
 * Strict decode, matching what MDK accepts (`cgka-traits` `MarmotAppEvent::decode`):
 * - the bytes are valid UTF-8 and one JSON object;
 * - the object carries exactly the six members `id, pubkey, created_at, kind,
 *   tags, content` — no `sig`, no unknown member, no duplicate key;
 * - `created_at` and `kind` are plain non-negative JSON integers;
 * - `pubkey` and `id` are 64 lowercase hex characters, `tags` is an array of
 *   string arrays, and no string carries an unpaired surrogate;
 * - `id` equals the canonical NIP-01 event id recomputed from the other
 *   members (lowercase-hex SHA-256 of `[0, pubkey, created_at, kind, tags,
 *   content]`).
 *
 * This is the integrity half of the authorship checks; the {@link
 * verifyApplicationRumorAuthorship} layer adds the MLS-sender binding.
 *
 * @param data - The serialized application data
 * @returns The deserialized, id-verified Rumor
 * @throws if the bytes are not a strictly-conformant, id-consistent rumor
 */
export declare function deserializeApplicationData(data: Uint8Array): Rumor;
/**
 * Strict-decodes an application payload and binds its authorship to the MLS
 * sender: the inner `pubkey` MUST equal the authenticated sender's Marmot
 * account identity (`foundation/identity.md`, `protocol-core/group-messaging.md`
 * "Receivers validate that the inner app event `pubkey` matches the Marmot
 * account identity authenticated by MLS"). Both the inner-id check (via {@link
 * deserializeApplicationData}) and this pubkey binding are decode-layer rules;
 * a failure of either is `invalid_encoding` and the message MUST be dropped.
 *
 * @param data - The serialized application payload (decrypted MLS bytes)
 * @param senderPubkeyHex - The MLS sender leaf's credential identity (lowercase
 *   hex Nostr pubkey), NOT the MLS signature key.
 * @returns The verified Rumor authored by the authenticated sender
 * @throws if decode/id verification fails or the author does not match the sender
 */
export declare function verifyApplicationRumorAuthorship(data: Uint8Array, senderPubkeyHex: string): Rumor;
/** @deprecated Kept for internal compatibility. Prefer `deserializeApplicationData`. */
export declare const deserializeApplicationRumor: typeof deserializeApplicationData;
