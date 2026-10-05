import type { CommitOrderingPriority } from "../core/convergence.js";
export type { CommitOrderingPriority };
/** Evidence captured while a locally-authored commit is still staged. */
export interface OwnCommitConvergenceStamp {
    /** Authenticated Marmot account identity of the committer. */
    committer: string;
    /** Authorization-aware ordering class decided at preparation time. */
    priority: CommitOrderingPriority;
    /** Exact proposal references consumed by the commit, sorted on storage. */
    consumedProposalRefs: Uint8Array[];
}
export type DecodedOwnCommitRecord = {
    kind: "stamped";
    wireBytes: Uint8Array;
    stamp: OwnCommitConvergenceStamp;
} | {
    kind: "legacy";
    wireBytes: Uint8Array;
};
/** Encodes a stamped own commit as a versioned, strictly-decodable record. */
export declare function encodeOwnCommitRecord(input: {
    wireBytes: Uint8Array;
    stamp: OwnCommitConvergenceStamp;
}): Uint8Array;
/**
 * Decodes a stamped record, or explicitly reports an old bare-wire record.
 * Bytes carrying the stamp magic always fail closed on malformed content.
 */
export declare function decodeOwnCommitRecord(bytes: Uint8Array): DecodedOwnCommitRecord;
/** Stable record identity: SHA-256 of the exact MLS wire commit, never the stamp. */
export declare function ownCommitRecordIdentity(record: DecodedOwnCommitRecord): Uint8Array;
