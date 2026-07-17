/** @module @category Core - Group Messages */
import { type MlsMessage, wireformats } from "ts-mls";
import type { GroupMessagePair } from "./group-message-crypto.js";
/**
 * Orders group commits by the content-derived convergence key
 * (`protocol-core/convergence.md`): by MLS source epoch ascending, then by the
 * lower `commit_digest = SHA-256(MLS message bytes)`. For a same-epoch race the
 * lowest commit digest wins.
 *
 * Transport arrival order, transport timestamps (`created_at`), and outer event
 * ids MUST NOT participate in this ordering — every member computes the same
 * order from the same MLS bytes, which is what makes convergence deterministic
 * across implementations.
 *
 * @param commits - Array of commit message pairs to order
 * @returns A new array ordered by the convergence key
 */
export declare function sortGroupCommits(commits: GroupMessagePair[]): GroupMessagePair[];
/**
 * Checks if a message is an application message (not a proposal or commit).
 */
export declare function isApplicationMessage(pair: GroupMessagePair): pair is GroupMessagePair & {
    message: MlsMessage & {
        wireformat: typeof wireformats.mls_private_message;
    };
};
/**
 * Checks if a message is a commit message.
 */
export declare function isCommitMessage(pair: GroupMessagePair): pair is GroupMessagePair & {
    message: MlsMessage & {
        wireformat: typeof wireformats.mls_private_message;
    };
};
/**
 * Checks if a message is a proposal message.
 */
export declare function isProposalMessage(pair: GroupMessagePair): pair is GroupMessagePair & {
    message: MlsMessage & {
        wireformat: typeof wireformats.mls_private_message;
    };
};
