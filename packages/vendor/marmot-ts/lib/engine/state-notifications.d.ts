import { type ClientState } from "../vendor/ts-mls/index.js";
/**
 * A group-state change derived from an accepted commit on the selected
 * branch (`convergence.md` "Applying the selected branch"). Every variant
 * carries `commitDigest` — the identity of the commit that produced it — so
 * a rewind that supersedes the commit can withdraw exactly the notifications
 * it derived (D-10, D-11). The notification SHAPE is implementation-defined;
 * `commit_digest` attribution is the conformance requirement.
 */
export type StateNotification = {
    kind: "epochAdvanced";
    commitDigest: Uint8Array;
    from: number;
    to: number;
} | {
    kind: "memberAdded";
    commitDigest: Uint8Array;
    pubkey: string;
} | {
    kind: "memberRemoved";
    commitDigest: Uint8Array;
    pubkey: string;
    actor?: string;
} | {
    kind: "componentChanged";
    commitDigest: Uint8Array;
    componentId: number;
} | {
    kind: "selfRemoved";
    commitDigest: Uint8Array;
} | {
    kind: "branchRecovered";
    commitDigest: Uint8Array;
    forkEpoch: number;
};
/**
 * Derives the {@link StateNotification}s produced by a single accepted commit
 * (`convergence.md` "Applying the selected branch") — a pure before/after diff
 * between `parentState` and `resultingState`, every entry attributed to
 * `commitDigest`. Ported from MDK's `group_state_changes.rs` split: this
 * function performs no I/O and holds no ledger; it only diffs two states.
 *
 * Emits in a fixed order so two calls over the same commit produce a
 * byte-identical result (T-03-31): `epochAdvanced`, then `memberAdded` (sorted
 * ascending by pubkey), then `memberRemoved` (sorted ascending by pubkey, no
 * `actor` — the committer is not visible to this pure diff), then
 * `componentChanged` (sorted ascending by component id), then `selfRemoved`
 * when the resulting state is the `removedFromGroup` tombstone and the parent's
 * was not.
 */
export declare function deriveStateNotifications(args: {
    parentState: ClientState;
    resultingState: ClientState;
    commitDigest: Uint8Array;
}): StateNotification[];
/**
 * Groups withdrawn {@link StateNotification}s by their producing commit's hex
 * digest, so a rewind site can emit exactly one {@link
 * StateInvalidatedIngestResult} per superseded commit (D-11) instead of one
 * per notification. Preserves each group's first-seen order; iteration order
 * of groups follows first appearance in `notifications`.
 */
export declare function groupWithdrawnNotificationsByCommit(notifications: readonly StateNotification[]): {
    commitDigest: Uint8Array;
    withdrawn: StateNotification[];
}[];
/**
 * A bounded ledger of {@link StateNotification}s derived from accepted
 * commits, keyed by the producing commit's hex digest — NOT by the delivery
 * state's confirmation tag as {@link DeliveredPayloadLedger} is. CONV-03
 * attributes notifications to the commit that produced them, so the commit
 * digest (rather than a branch/state tag) is the natural withdrawal key.
 *
 * Structural sibling of `DeliveredPayloadLedger`: entries are pruned only
 * below the oldest state still named by either retained history or the fork
 * tree. A finite, pruned tree can therefore bound this ledger; with an
 * unpruned full-history tree (including `maxRewindCommits: Infinity`) the
 * correctness horizon deliberately implies unbounded retention.
 */
export declare class StateNotificationLedger {
    #private;
    /** Number of remembered commit-notification entries. */
    get size(): number;
    /**
     * Whether a commit's notifications are already recorded for `(digest,
     * epoch)`.
     *
     * WR-14: `invalidatedByRewind` KEEPS entries whose digest is on the winning
     * chain, so every prefix link that was already ledger-recorded when it was
     * first applied in-order survives a rewind. Callers use this to avoid
     * re-reporting those links to the application as freshly-applied.
     */
    has(digest: Uint8Array, epoch: number): boolean;
    /**
     * Remembers the notifications derived from a commit at `epoch`. Empty
     * derivations are retained: their digest identity is still needed to make a
     * later rewind complete and idempotent even though there is nothing to emit.
     *
     * Idempotent on `(digest, epoch)` (WR-14): a rewind whose winning chain
     * includes links that were already applied and recorded in-order would
     * otherwise push a second entry with the same digest and epoch. A later
     * rewind that superseded them then withdrew each of those notifications
     * TWICE, breaking CONV-03's "withdraw exactly the notifications it derived"
     * invariant from the other direction, and compounding the ledger's
     * unbounded growth.
     */
    record(digest: Uint8Array, epoch: number, notifications: StateNotification[]): void;
    /**
     * Removes and returns the notifications withdrawn by a rewind to a
     * canonical branch: those derived strictly after `forkEpoch` whose
     * producing commit digest is not in `canonicalDigests`. Notifications
     * produced on the canonical branch, and any at or below the fork epoch
     * (shared history), are retained.
     */
    invalidatedByRewind(forkEpoch: number, canonicalDigests: ReadonlySet<string>): StateNotification[];
    /**
     * Drops entries below the caller's tree-aware correctness horizon. The
     * engine supplies `min(retained anchor, oldest tree-node epoch)` so no commit
     * still nameable by a fork candidate loses its withdrawal record.
     */
    pruneBelow(epoch: number): void;
}
