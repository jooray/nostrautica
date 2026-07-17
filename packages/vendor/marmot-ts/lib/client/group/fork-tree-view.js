/** @module @category Client - Group */
import { bytesToHex } from "@noble/hashes/utils.js";
/**
 * Builds a {@link ForkTreeView} from a {@link GroupHistoryTree} and the
 * canonical (live) tip tag — the confirmation tag of the engine's current
 * state, i.e. the branch convergence settled on. Nodes on the path from the
 * root to that tip are flagged `canonical`.
 */
export function buildForkTreeView(tree, canonicalTipTag) {
    const canonicalPath = (canonicalTipTag && tree.path(canonicalTipTag)) || [];
    const onCanonical = new Set(canonicalPath);
    const nodes = tree.tags().map((tag) => {
        const node = tree.node(tag);
        return {
            tag: node.tag,
            epoch: node.epoch,
            parentTag: node.parentTag,
            childTags: node.childTags,
            isTip: node.childTags.length === 0,
            canonical: onCanonical.has(tag),
            isCanonicalTip: tag === canonicalTipTag,
            commit: node.edge
                ? {
                    digestHex: bytesToHex(node.edge.commitDigest),
                    senderLeafIndex: node.edge.senderLeafIndex,
                }
                : undefined,
        };
    });
    return {
        rootTag: tree.rootTag,
        canonicalTip: canonicalTipTag,
        canonicalPath,
        tips: tree.tips(),
        nodes,
    };
}
//# sourceMappingURL=fork-tree-view.js.map