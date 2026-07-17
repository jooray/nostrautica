import { ClientState } from "./clientState.js";
import { LeafNodeExtension } from "./extension.js";
import { MlsFramedMessage } from "./message.js";
import { Proposal } from "./proposal.js";
import type { MlsContext } from "./mlsContext.js";
/** @public */
export interface CreateMessageResult {
    newState: ClientState;
    message: MlsFramedMessage;
    consumed: Uint8Array[];
}
/** @public */
export declare function createProposal(params: {
    context: MlsContext;
    state: ClientState;
    wireAsPublicMessage?: boolean;
    proposal: Proposal;
    authenticatedData?: Uint8Array;
}): Promise<CreateMessageResult>;
/**
 * Creates a `self_remove` proposal: the caller proposes their own removal for
 * another member to commit. Framed as a PublicMessage (draft-ietf-mls-extensions
 * / MIP-03) so the leaving member is the recorded MLS sender and the proposal can
 * be committed by reference. The committer cannot be the sender (RFC 9420 §12.2),
 * so this proposal advances no epoch on its own.
 *
 * @public
 */
export declare function createSelfRemoveProposal(params: {
    context: MlsContext;
    state: ClientState;
    authenticatedData?: Uint8Array;
}): Promise<CreateMessageResult>;
/** @public */
export interface CreateUpdateProposalResult extends CreateMessageResult {
    /**
     * HPKE keypair for the proposer's new leaf. The proposer MUST install the
     * private key into `state.privatePath` (via `updateLeafKey`) only when the
     * commit that applies this proposal is handled, because commits that do not
     * include the proposal leave the proposer's leaf public key unchanged. The
     * public key lets the caller detect which of those two outcomes occurred by
     * comparing it to the post-commit tree's own-leaf public key.
     */
    newLeafKeypair: {
        hpkePublicKey: Uint8Array;
        hpkePrivateKey: Uint8Array;
    };
}
/** @public */
export declare function createUpdateProposal(params: {
    context: MlsContext;
    state: ClientState;
    wireAsPublicMessage?: boolean;
    authenticatedData?: Uint8Array;
    leafNodeExtensions?: LeafNodeExtension[];
}): Promise<CreateUpdateProposalResult>;
/** @public */
export declare function createApplicationMessage(params: {
    context: MlsContext;
    state: ClientState;
    message: Uint8Array;
    authenticatedData?: Uint8Array;
}): Promise<CreateMessageResult>;
