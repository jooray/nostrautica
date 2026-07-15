/** @module @category Core - Group Lifecycle */
/**
 * The Marmot v2 group lifecycle state machine (`protocol-core/group-state.md`).
 *
 * Each group has exactly one canonical MLS state at a time; a client may hold
 * candidate or pending state transiently but exposes only one canonical state.
 * The lifecycle gates when local commits may be prepared and whether retained
 * inbound may change canonical state.
 */
export declare const groupLifecycleStates: {
    /** Has a canonical MLS epoch; normal inbound/outbound work may proceed. */
    readonly stable: "Stable";
    /** A local group-state commit is prepared but its publish is unconfirmed. */
    readonly pendingPublish: "PendingPublish";
    /** Publication confirmed; the staged commit is being applied locally. */
    readonly merging: "Merging";
    /** A fork-shaped conflict was detected; selecting a safe retained branch. */
    readonly recovering: "Recovering";
    /** No safe branch can be selected from retained local material (client-local). */
    readonly unrecoverable: "Unrecoverable";
};
/** A group lifecycle state value. */
export type GroupLifecycleState = (typeof groupLifecycleStates)[keyof typeof groupLifecycleStates];
/** Returns whether `from -> to` is a legal lifecycle transition. */
export declare function canTransitionLifecycle(from: GroupLifecycleState, to: GroupLifecycleState): boolean;
/** Throws if `from -> to` is not a legal lifecycle transition; returns `to`. */
export declare function transitionLifecycle(from: GroupLifecycleState, to: GroupLifecycleState): GroupLifecycleState;
/**
 * A client MAY prepare a new local group-state commit only in `Stable`. (Fork
 * detection also runs only from `Stable`.)
 */
export declare function mayPrepareLocalCommit(state: GroupLifecycleState): boolean;
/**
 * Whether retained inbound may change canonical group state in this lifecycle
 * state. Only `Stable` (normal processing) and `Recovering` (a selected branch
 * is applied) may; `PendingPublish`, `Merging`, and `Unrecoverable` MUST NOT.
 */
export declare function mayApplyRetainedInbound(state: GroupLifecycleState): boolean;
/** Whether fork detection may run (only from settled `Stable` canonical state). */
export declare function mayRunForkDetection(state: GroupLifecycleState): boolean;
