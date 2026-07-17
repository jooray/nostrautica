/** @module @category Engine */
import { type ClientState, type IncomingMessageCallback } from "ts-mls";
/**
 * Build an incoming-message callback that enforces MIP-03 "admin-only commits".
 */
export declare function createAdminCommitPolicyCallback(args: {
    ratchetTree: ClientState["ratchetTree"];
    adminPubkeys: string[];
    ciphersuiteId: number;
    onUnverifiableCommit?: "reject" | "retry";
}): IncomingMessageCallback;
