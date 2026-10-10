/** @module @category Engine */
import { type MlsMessage } from "../vendor/ts-mls/index.js";
/**
 * The content-derived dedup id of an MLS message (`inbound-processing.md`;
 * mirrors the reference engine's `content_dedup_id`): the lowercase-hex SHA-256
 * of the TLS-serialized MLS message wire bytes, with no domain-separation
 * prefix.
 *
 * It is computed over the peeled MLS message (the inner wire bytes), not the
 * outer transport ciphertext, so the same message re-wrapped in a fresh kind-445
 * envelope — new ephemeral key + nonce, hence a new Nostr event id — yields the
 * same id. Distinct MLS ciphertexts produce distinct ids, so genuinely different
 * messages are never collapsed. This is the key for replay dedup
 * (`seen_message_ids`) and content-keyed own-echo detection (`sent_message_ids`).
 */
export declare function contentDedupId(message: MlsMessage): string;
