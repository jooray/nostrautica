/** @module @category Engine */
import { type ClientState } from "../vendor/ts-mls/index.js";
import { type AppComponentId } from "../core/components/ids.js";
/** Why {@link validateWelcomeGroupState} rejected a joined group. */
export type WelcomeGroupStateRejectReason = "missing-required-capabilities" | "missing-app-data-dictionary" | "missing-required-component" | "unsupported-required-component" | "invalid-component" | "invalid-component-location" | "unsupported-member-role" | "member-lacks-required-component" | "author-not-admin" | "admin-without-member-leaf";
/** Thrown by {@link validateWelcomeGroupState}. */
export declare class WelcomeGroupStateError extends Error {
    readonly reason: WelcomeGroupStateRejectReason;
    constructor(reason: WelcomeGroupStateRejectReason, message: string);
}
/**
 * Validates the Marmot group state a Welcome would install, before anything
 * is persisted (`protocol-core/joining.md` receiving flow, steps 6 to 8):
 *
 * 1. The GroupContext requires `app_data_dictionary` (`0x0006`) and
 *    `app_data_update` (`0x0008`) (`group-setup.md`).
 * 2. It carries an `app_data_dictionary` with an `app_components` list that
 *    requires `0x8003` (admin policy) and `0x8009` (account proof).
 * 3. The dictionary holds no leaf-only `0x8009` data and no `safe_aad`
 *    (`0x0002`) group state, which this library cannot process.
 * 4. Every component whose format this library knows decodes. Unknown
 *    optional components stay opaque (`app-components/README.md`).
 * 5. Every required component is one this client supports and has
 *    GroupContext state (`0x8009` is leaf-only and exempt). A member that
 *    does not support every required component MUST NOT join.
 * 6. Every member leaf advertises every required component in its
 *    `app_components` support list (MDK `validate_resulting_leaf_capabilities`).
 * 7. The joining leaf advertises every agent-text-stream role the group
 *    requires (`agent-text-stream-quic-v1.md`).
 * 8. The Welcome author (the GroupInfo signer) is an admin
 *    (`admin-policy-v1.md`: the sole membership-add authority).
 * 9. Every admin has a member leaf (`admin-policy-v1.md` "Validation").
 *
 * This mirrors MDK's join checks (`group_lifecycle.rs` `do_join_welcome`
 * steps 5b to 5e, `app_components.rs`
 * `validate_current_profile_group_context`).
 *
 * @throws {WelcomeGroupStateError}
 */
export declare function validateWelcomeGroupState(args: {
    state: ClientState;
    /** Leaf index of the GroupInfo signer (the Welcome author). */
    authorLeafIndex: number;
    /** Component ids this client supports. Defaults to {@link SUPPORTED_APP_COMPONENT_IDS}. */
    supportedComponentIds?: readonly AppComponentId[];
}): void;
