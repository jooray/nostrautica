/** @module @category Engine */
import type { BranchCandidate, ConvergencePolicy } from "../core/convergence.js";
import type { GroupHistoryTree } from "./history-tree.js";
/**
 * The candidate set for a tree-fed re-convergence pass: the shared fork root plus
 * one {@link BranchCandidate} per branch tip reachable from it (including the
 * current tip), scored later by {@link selectCanonicalBranch}.
 */
export interface TreeBranchSet {
    /** The single fork root all candidates are measured from (its hex node tag). */
    rootTag: string;
    /** One candidate per tip descending from the root (the current tip included). */
    candidates: BranchCandidate[];
}
/**
 * Builds the candidate branch set for re-scoring the persisted fork history
 * against the current tip, sourcing everything from the {@link GroupHistoryTree}
 * (Marmot v2 `protocol-core/convergence.md`). Unlike `ForkRecovery`, which
 * replays the incoming commit pool, this reads the tree's already-retained fork
 * snapshots, so a competing branch known only on disk is re-evaluated without the
 * transport re-delivering it.
 *
 * Construction is fully synchronous and structural: every datum a candidate needs
 * (epoch, tip digest) is in the tree's light index — `tipDigest` is the stored
 * `edge.commitDigest`, byte-identical to the `sha256` of the commit MLS bytes that
 * scoring expects. App-payload witnesses are layered on by the caller when
 * available; on load there are none, and the structural keys
 * (depth + lower tip digest) still pick a deterministic, member-independent
 * winner.
 *
 * A single shared fork root is chosen — the eligible competing tip's fork point at
 * the *minimum* epoch (the current tip's path is linear, so its ancestor at that
 * epoch is unique). Every tip descending from that root becomes a candidate at the
 * shared `forkEpoch`, mirroring the pool path's single-root semantics
 * (`ingest.ts` `minForkEpoch`). Including the current tip makes "already
 * canonical" a clean no-op for the selector.
 *
 * @returns the candidate set, or `undefined` when no eligible competing tip exists
 *   (no fork within the rollback horizon — nothing to switch to).
 */
export declare function buildTreeBranchSet(tree: GroupHistoryTree, currentTipTag: string, policy: ConvergencePolicy): TreeBranchSet | undefined;
