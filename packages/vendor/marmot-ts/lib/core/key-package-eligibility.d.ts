/** @module @category Core - Key Package */
import type { NostrEvent } from "applesauce-core/helpers/event";
import { type ClientState, type GroupContextExtension, type GroupInfo, type KeyPackage } from "../vendor/ts-mls/index.js";
/**
 * Lists every group requirement `keyPackage`'s LeafNode does not advertise:
 * the `required_capabilities` extension/proposal/credential types, every
 * component in the group's `app_components` requirement list (checked against
 * the leaf's own `app_components` support list), and the agent-text-stream
 * role capabilities the group's policy requires. Returns `[]` when the
 * KeyPackage can be added.
 *
 * MDK refuses to create a group or add a member that misses any of these
 * (`group_lifecycle.rs` `do_create_group`, and
 * `validate_resulting_leaf_capabilities` on every commit), so an Add of such a
 * KeyPackage is rejected by MDK members.
 */
export declare function missingGroupRequirements(keyPackage: KeyPackage, groupExtensions: GroupContextExtension[]): string[];
/** The outcome of evaluating a KeyPackage against a group's add requirements. */
export interface KeyPackageEligibility {
    /** True when the KeyPackage satisfies every add requirement (no reasons). */
    eligible: boolean;
    /** True when the KeyPackage's account is already a member of the group. */
    alreadyMember: boolean;
    /** The KeyPackage's MLS cipher suite id, or `-1` if the event was undecodable. */
    cipherSuite: number;
    /** Human-readable reasons the KeyPackage is not eligible (empty when it is). */
    reasons: string[];
}
/**
 * Evaluates whether a candidate's KeyPackage event (kind 30443) can be added to a
 * group, against every Marmot add requirement: cipher-suite match, the group's
 * `required_capabilities` (extension/proposal/credential types), its required
 * app components, the agent-text-stream-QUIC `required_member_roles` policy,
 * the Lifetime cap/current check, the `mls_proposals` tag matching the leaf's
 * advertised proposals (with or without GREASE), and whether the KeyPackage's
 * account is already a member.
 *
 * This is the eligibility logic an app needs before sending an invite — the
 * invite proposal itself enforces only {@link missingGroupRequirements}. A
 * `reasons` array of length 0 means the KeyPackage is safe to add; a non-empty
 * array explains every failing requirement. Never throws: an undecodable
 * KeyPackage yields `eligible: false` with an `undecodable: …` reason.
 *
 * @param state - The local group state to evaluate against (`group.state`).
 * @param keyPackageEvent - The invitee's kind-30443 KeyPackage event.
 */
export declare function evaluateKeyPackageForGroup(state: ClientState | GroupInfo, keyPackageEvent: NostrEvent): KeyPackageEligibility;
