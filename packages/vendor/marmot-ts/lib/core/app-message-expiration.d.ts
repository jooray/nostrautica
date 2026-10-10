/** @module @category Core - Group Messages */
import type { ClientState } from "../vendor/ts-mls/index.js";
/**
 * The transport expiry for an outbound application message
 * (`app-components/message-retention-v1.md`):
 * `checked_u64(app_payload.created_at + disappearing_message_secs)`, read from
 * the message's source-epoch state.
 *
 * Returns `undefined` — no expiry hint — when retention is absent or `0`, when
 * the payload has no readable integer `created_at`, when `created_at` is not
 * exactly representable as a JS number (the spec forbids computing through an
 * inexact JSON number), or when the sum exceeds `2^64 - 1`. In every such case
 * the message itself stays valid.
 *
 * @param state - The group state the message is encrypted under (source epoch)
 * @param payload - The serialized Marmot app payload
 */
export declare function getAppMessageExpiration(state: ClientState, payload: Uint8Array): bigint | undefined;
