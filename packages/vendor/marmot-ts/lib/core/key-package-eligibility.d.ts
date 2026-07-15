/** @module @category Core - Key Package */
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { ClientState, GroupInfo } from "ts-mls";
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
 * `required_capabilities` (extension/proposal/credential types), the
 * agent-text-stream-QUIC `required_member_roles` policy, and whether the
 * KeyPackage's account is already a member.
 *
 * This is the eligibility logic an app needs before sending an invite — the
 * library's {@link createInviteIntent} only checks the credential identity. A
 * `reasons` array of length 0 means the KeyPackage is safe to add; a non-empty
 * array explains every failing requirement. Never throws: an undecodable
 * KeyPackage yields `eligible: false` with an `undecodable: …` reason.
 *
 * @param state - The local group state to evaluate against (`group.state`).
 * @param keyPackageEvent - The invitee's kind-30443 KeyPackage event.
 */
export declare function evaluateKeyPackageForGroup(state: ClientState | GroupInfo, keyPackageEvent: NostrEvent): KeyPackageEligibility;
