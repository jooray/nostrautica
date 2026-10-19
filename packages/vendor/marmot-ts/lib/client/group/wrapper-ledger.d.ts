import type { GenericKeyValueStore } from "../../utils/key-value.js";
import type { StateNotification } from "../../engine/state-notifications.js";
export type TerminalWrapperOutcome = "accepted" | "stale" | "invalidated";
export type WrapperRetentionCoordinate = {
    sourceEpoch: number;
    completedAtEpoch?: never;
} | {
    completedAtEpoch: number;
    sourceEpoch?: never;
};
/** Durable, group-scoped record of verified transport wrappers handled terminally. */
export declare class TerminalWrapperLedger {
    #private;
    readonly store: GenericKeyValueStore<Uint8Array>;
    readonly groupId: string;
    constructor(store: GenericKeyValueStore<Uint8Array>, groupId: string);
    get(eventId: string, currentStateHash?: string): Promise<TerminalWrapperOutcome | undefined>;
    /** Records the durable pre-apply side of the ingest transaction. */
    begin(eventId: string, priorStateHash: string): Promise<void>;
    /** Binds recoverable application evidence to this wrapper's exact result. */
    stageApplied(eventId: string, priorStateHash: string, resultingStateHash: string, outcome: TerminalWrapperOutcome): Promise<void>;
    record(eventId: string, outcome: TerminalWrapperOutcome, coordinate?: WrapperRetentionCoordinate): Promise<void>;
    /** Unknown/prepared/applied evidence cannot authorize provenance release. */
    hasUnfinished(): Promise<boolean>;
    /** Migrate legacy terminal rows locally, then retire strictly below the floor. */
    compactRetained(floorEpoch: number, completedAtEpoch: number, pinnedIds?: ReadonlySet<string>): Promise<void>;
    /** Only completed wrapper evidence belongs to terminal cleanup. */
    cleanupCompleted(): Promise<void>;
}
type StoredEffectV2 = {
    version: 2 | 3;
    state: "pending" | "observed";
    direction: "withdrawal" | "adoption";
    forkEpoch?: number;
    producingDigest?: string;
    producingEpoch?: number;
    notifications: Array<Omit<StateNotification, "commitDigest"> & {
        commitDigest: string;
    }>;
};
export type PendingConvergenceEffect = {
    kind: "stateInvalidated";
    commitDigest: Uint8Array;
    forkEpoch: number;
    withdrawn: StateNotification[];
} | {
    kind: "stateRevalidated";
    commitDigest: Uint8Array;
    effectId: Uint8Array;
    notifications: StateNotification[];
};
/** Durable observation verdicts for branch-selection withdrawal/re-adoption. */
export declare class ConvergenceEffectLedger {
    #private;
    readonly store: GenericKeyValueStore<Uint8Array>;
    readonly groupId: string;
    constructor(store: GenericKeyValueStore<Uint8Array>, groupId: string);
    prepareWithdrawal(digest: Uint8Array, forkEpoch: number, notifications: readonly StateNotification[]): Promise<boolean>;
    prepareAdoption(digest: Uint8Array, notifications: readonly StateNotification[]): Promise<boolean>;
    acknowledge(digest: Uint8Array, direction: StoredEffectV2["direction"]): Promise<void>;
    pending(): Promise<PendingConvergenceEffect[]>;
    /** Completed effects retire only when no proposed selectable member names them. */
    compactRetained(digests: ReadonlySet<string>): Promise<void>;
    hasOpaqueDependency(): Promise<boolean>;
}
export {};
