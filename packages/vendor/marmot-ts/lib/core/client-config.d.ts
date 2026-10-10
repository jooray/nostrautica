/** @module @category Core - Client State */
import { ClientConfig, type KeyRetentionConfig } from "../vendor/ts-mls/index.js";
/**
 * MLS secret retention for Marmot groups.
 *
 * - `retainKeysForEpochs: 5` — `protocol-core/retained-history.md` delivers an
 *   application message while `tip_epoch - message_epoch <=
 *   app_payload_past_epoch_limit` (5, `protocol-core/convergence.md`), so the
 *   receiver secrets of the last five past epochs must survive. The ts-mls
 *   default of 4 drops a message sent five commits ago as "epoch too old".
 * - `retainKeysForGenerations: 100` and `maximumForwardRatchetSteps: 1000` —
 *   the within-epoch reordering window MDK configures for OpenMLS
 *   (`out_of_order_tolerance` / `maximum_forward_distance` in
 *   `cgka-engine/src/wire_format.rs`). Relays return stored events newest
 *   first, so a member catching up on a burst sees high generations before
 *   low ones; with the ts-mls default of 10 every message more than ten
 *   generations behind the newest one was lost for good.
 */
export declare const marmotKeyRetentionConfig: KeyRetentionConfig;
/** Default ClientConfig for Marmot, passed to every ts-mls operation. */
export declare const defaultMarmotClientConfig: ClientConfig;
