/** @module @category Core - Group Messages */
import { contentTypes, encode, mlsMessageEncoder, wireformats, } from "../vendor/ts-mls/index.js";
import { commitDigest, compareCommitOrderingKeys, } from "./convergence.js";
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
export function sortGroupCommits(commits) {
    const keyed = commits.map((pair) => {
        const sourceEpoch = sourceEpochOf(pair.message);
        const key = {
            sourceEpoch,
            // commit_digest is over the serialized MLS message bytes; ts-mls TLS
            // encoding is canonical, so this matches the transmitted commit bytes.
            commitDigest: commitDigest(encode(mlsMessageEncoder, pair.message)),
        };
        return { pair, key };
    });
    keyed.sort((a, b) => compareCommitOrderingKeys(a.key, b.key));
    return keyed.map((entry) => entry.pair);
}
function sourceEpochOf(message) {
    let epoch;
    switch (message.wireformat) {
        case wireformats.mls_private_message:
            epoch = message.privateMessage.epoch;
            break;
        case wireformats.mls_public_message:
            epoch = message.publicMessage.content.epoch;
            break;
        default:
            throw new Error(`Unsupported MLS wire format for commit ordering: ${message.wireformat}`);
    }
    if (epoch < 0n || epoch > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`MLS source epoch must be between 0 and Number.MAX_SAFE_INTEGER: ${epoch}`);
    }
    return Number(epoch);
}
/**
 * Checks if a message is an application message (not a proposal or commit).
 */
export function isApplicationMessage(pair) {
    if (pair.message.wireformat !== wireformats.mls_private_message)
        return false;
    return pair.message.privateMessage.contentType === contentTypes.application;
}
/**
 * Checks if a public or private framed message carries a commit.
 */
export function isCommitMessage(pair) {
    switch (pair.message.wireformat) {
        case wireformats.mls_private_message:
            return pair.message.privateMessage.contentType === contentTypes.commit;
        case wireformats.mls_public_message:
            return (pair.message.publicMessage.content.contentType === contentTypes.commit);
        default:
            return false;
    }
}
/**
 * Checks if a public or private framed message carries a proposal.
 */
export function isProposalMessage(pair) {
    switch (pair.message.wireformat) {
        case wireformats.mls_private_message:
            return pair.message.privateMessage.contentType === contentTypes.proposal;
        case wireformats.mls_public_message:
            return (pair.message.publicMessage.content.contentType === contentTypes.proposal);
        default:
            return false;
    }
}
