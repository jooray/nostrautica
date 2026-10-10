/** @module @category Core - Capabilities */
import { Capabilities } from "../vendor/ts-mls/index.js";
/**
 * Default capabilities for Marmot key packages.
 *
 * Per `protocol-core/group-setup.md` (capability checks before create/add) and
 * `foundation/key-packages.md`, KeyPackages MUST advertise the capabilities a Marmot group
 * requires — the extensions and proposals `ensureMarmotCapabilities` adds (app_data_dictionary,
 * the agent-text-stream `receive` role, app_data_update, self_remove) — to pass
 * validation when added to groups.
 */
export declare function defaultCapabilities(): Capabilities;
