/** @module @category Core - Group Messages */
import { type MlsPrivateMessage, type MlsPublicMessage } from "../vendor/ts-mls/index.js";
import type { GroupMessagePair } from "./group-message-crypto.js";
/**
 * Pre-orders group commits by the content-derived epoch/digest key
 * (`protocol-core/convergence.md`): by MLS source epoch ascending, then by the
 * lower `commit_digest = SHA-256(MLS message bytes)`. Full branch selection
 * additionally evaluates depth, witnesses, priority, and authenticated committers
 * in the group engine.
 *
 * Transport arrival order, transport timestamps (`created_at`), and outer event
 * ids MUST NOT participate in this ordering — every member computes the same
 * order from the same MLS bytes, which is what makes convergence deterministic
 * across implementations.
 *
 * @param commits - Array of commit message pairs to order
 * @returns A new array ordered by the convergence key
 * @throws If a message is not public/private framed carriage, or its epoch is
 * negative or exceeds Number.MAX_SAFE_INTEGER.
 */
export declare function sortGroupCommits(commits: GroupMessagePair[]): GroupMessagePair[];
/**
 * Checks if a message is an application message (not a proposal or commit).
 */
export declare function isApplicationMessage(pair: GroupMessagePair): pair is GroupMessagePair & {
    message: MlsPrivateMessage;
};
/**
 * Checks if a public or private framed message carries a commit.
 */
export declare function isCommitMessage(pair: GroupMessagePair): pair is GroupMessagePair & {
    message: MlsPrivateMessage | MlsPublicMessage;
};
/**
 * Checks if a public or private framed message carries a proposal.
 */
export declare function isProposalMessage(pair: GroupMessagePair): pair is GroupMessagePair & {
    message: MlsPrivateMessage | MlsPublicMessage;
};
