import type { GroupHistoryTree } from "./history-tree.js";
/** An exact protocol obligation, released by its owning operation. */
export interface HistoryRetentionPin {
    stateTag: string;
    reason: "publication" | "recovery" | "retraction" | "application" | "resumption";
    receiverEpoch?: number;
    /** A deferred by-reference proposal is unresolved: do not project this state. */
    unresolvedReceiverDependency?: boolean;
}
export interface HistoryRetentionOptions {
    canonicalTipTag: string;
    maxRewindCommits: number;
    appPayloadPastEpochLimit: number;
    pins?: readonly HistoryRetentionPin[];
}
export interface HistoryRetentionPlan {
    readonly revision: number;
    readonly canonicalTipTag: string;
    readonly tipEpoch: number;
    readonly floorEpoch: number;
    readonly appFloorEpoch: number;
    readonly logicalRootTag?: string;
    readonly retainedTags: readonly string[];
    readonly excludedTags: readonly string[];
    /** Undefined means an unresolved dependency postponed that rewrite. */
    readonly receiverEpochs: ReadonlyMap<string, readonly number[] | undefined>;
    readonly snapshots: ReadonlyMap<string, Uint8Array>;
}
export declare function retentionFloor(tipEpoch: number, horizon: number): number;
/** Inclusive canonical anchor, eligible branch topology and exact connected pins. */
export declare function retainedTopology(tree: GroupHistoryTree, options: HistoryRetentionOptions): {
    retainedTags: string[];
    excludedTags: string[];
    logicalRootTag: string | undefined;
    floorEpoch: number;
    appFloorEpoch: number;
    tipEpoch: number;
};
/** Decode a copy: only nested historical receivers are eligible for release. */
export declare function projectHistoricalReceivers(snapshot: Uint8Array, appFloorEpoch: number, pins: readonly HistoryRetentionPin[]): {
    snapshot: Uint8Array;
    receiverEpochs: number[] | undefined;
};
