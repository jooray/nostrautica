import type { GenericKeyValueStore } from "../../utils/key-value.js";
import type { StateNotification } from "../../engine/state-notifications.js";
export type TerminalWrapperOutcome = "accepted" | "stale" | "invalidated";
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
    record(eventId: string, outcome: TerminalWrapperOutcome): Promise<void>;
}
type StoredEffectV2 = {
    version: 2;
    state: "pending" | "observed";
    direction: "withdrawal" | "adoption";
    forkEpoch?: number;
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
}
export {};
