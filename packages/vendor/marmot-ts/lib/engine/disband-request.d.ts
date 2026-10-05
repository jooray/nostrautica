/** @module @category Engine */
export type DisbandFailureReason = "NoLongerMember" | "NoLongerAdmin";
export type DisbandRequest = {
    status: "pending";
    requestedAtMs: number;
    lastPreparedEpoch: number | null;
} | {
    status: "failed";
    reason: DisbandFailureReason;
    requestedAtMs: number;
    lastPreparedEpoch: null;
};
export declare function disbandRequestKey(groupIdHex: string): string;
export interface StoredDisbandConvergence {
    readonly generation: number;
    readonly baseEpoch: number;
    readonly openedAtWallMs: number;
    readonly deadlineWallMs: number;
    readonly lastRelevantInputWallMs: number;
    readonly candidates: readonly {
        readonly commitDigest: string;
        readonly actorPubkey: string;
        readonly sourceEpoch: number;
        readonly parentTag: string;
        readonly childTag: string;
        readonly commitMessage: string;
        readonly resultingState: string;
    }[];
}
export declare function disbandConvergenceKey(groupIdHex: string): string;
export declare function encodeDisbandConvergence(record: StoredDisbandConvergence): Uint8Array;
export declare function decodeDisbandConvergence(data: Uint8Array): StoredDisbandConvergence;
export declare function encodeDisbandRequest(request: DisbandRequest): Uint8Array;
export declare function decodeDisbandRequest(data: Uint8Array): DisbandRequest;
