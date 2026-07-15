/** @module @category Client - Proposals */
import { isEvent } from "applesauce-core/helpers/event";
import { defaultProposalTypes } from "ts-mls";
import { verifyLeafAccountIdentityProof } from "../../../core/account-identity-proof.js";
import { getKeyPackage } from "../../../core/key-package-event.js";
/** Builds a proposal to invite a user to the group from a key package event or raw key package */
export function proposeInviteUser(keyPackageEvent) {
    return async ({ ciphersuite }) => {
        const keyPackage = isEvent(keyPackageEvent)
            ? getKeyPackage(keyPackageEvent)
            : keyPackageEvent;
        // The invitee's LeafNode MUST carry a valid Marmot account identity proof;
        // the spec validates this on every leaf with no legacy fallback
        // (foundation/account-identity-proof-v1.md §Validation). Throws if missing
        // or invalid.
        verifyLeafAccountIdentityProof(keyPackage.leafNode, ciphersuite.id);
        return {
            proposalType: defaultProposalTypes.add,
            add: { keyPackage },
        };
    };
}
//# sourceMappingURL=invite-user.js.map