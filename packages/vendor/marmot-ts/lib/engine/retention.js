/** Internal retention contracts; deliberately absent from public barrels. */
import { bytesToHex } from "@noble/hashes/utils.js";
import { defaultProposalTypes } from "../vendor/ts-mls/index.js";
import { deserializeClientState, serializeClientState, } from "../core/client-state.js";
import { DEFAULT_CONVERGENCE_POLICY, isBranchEligible, } from "../core/convergence.js";
export function retentionFloor(tipEpoch, horizon) {
    if (!Number.isSafeInteger(tipEpoch) ||
        tipEpoch < 0 ||
        (horizon !== Infinity && (!Number.isSafeInteger(horizon) || horizon < 0)))
        throw new Error("History retention: invalid epoch or horizon");
    return horizon === Infinity ? 0 : Math.max(0, tipEpoch - horizon);
}
/** Inclusive canonical anchor, eligible branch topology and exact connected pins. */
export function retainedTopology(tree, options) {
    if (!tree.size)
        return {
            retainedTags: [],
            excludedTags: [],
            logicalRootTag: undefined,
            floorEpoch: 0,
            appFloorEpoch: 0,
            tipEpoch: 0,
        };
    const tipEpoch = tree.epochOf(options.canonicalTipTag);
    const path = tree.path(options.canonicalTipTag);
    if (tipEpoch === undefined || !path)
        throw new Error("History retention: canonical tip absent");
    const floorEpoch = retentionFloor(tipEpoch, options.maxRewindCommits);
    const appFloorEpoch = retentionFloor(tipEpoch, options.appPayloadPastEpochLimit);
    const keep = new Set();
    for (const tag of path)
        if (tree.epochOf(tag) >= Math.min(floorEpoch, appFloorEpoch))
            keep.add(tag);
    if (options.maxRewindCommits === Infinity)
        for (const tag of tree.tags())
            keep.add(tag);
    else
        for (const tip of tree.tips()) {
            const fork = tree.lowestCommonAncestor(tip, options.canonicalTipTag);
            if (fork === undefined)
                throw new Error("History retention: disconnected candidate");
            if (!isBranchEligible(tipEpoch, {
                id: tip,
                forkEpoch: tree.epochOf(fork),
                tipEpoch: tree.epochOf(tip),
                tipDigest: new Uint8Array(),
                appWitnesses: [],
            }, {
                ...DEFAULT_CONVERGENCE_POLICY,
                maxRewindCommits: options.maxRewindCommits,
            }))
                continue;
            const branch = tree.path(tip);
            for (const tag of branch.slice(branch.indexOf(fork)))
                keep.add(tag);
        }
    // In-window application source nodes remain usable independently of rewind.
    for (const tag of tree.tags())
        if (tree.epochOf(tag) >= appFloorEpoch && tree.epochOf(tag) <= tipEpoch) {
            const fork = tree.lowestCommonAncestor(tag, options.canonicalTipTag);
            const forkEpoch = tree.epochOf(fork);
            if (forkEpoch >= floorEpoch)
                for (const ancestor of tree
                    .path(tag)
                    .slice(tree.path(tag).indexOf(fork)))
                    keep.add(ancestor);
        }
    for (const pin of options.pins ?? []) {
        const pinnedPath = tree.path(pin.stateTag);
        if (!pinnedPath)
            throw new Error("History retention: required pinned state absent");
        const common = tree.lowestCommonAncestor(pin.stateTag, options.canonicalTipTag);
        for (const tag of pinnedPath.slice(pinnedPath.indexOf(common)))
            keep.add(tag);
        for (const tag of path.slice(path.indexOf(common)))
            keep.add(tag);
    }
    const retainedTags = tree.tags().filter((tag) => keep.has(tag));
    const logicalRootTag = retainedTags.find((tag) => !keep.has(tree.parentOf(tag) ?? ""));
    return {
        retainedTags,
        excludedTags: tree.tags().filter((tag) => !keep.has(tag)),
        logicalRootTag,
        floorEpoch,
        appFloorEpoch,
        tipEpoch,
    };
}
/** Decode a copy: only nested historical receivers are eligible for release. */
export function projectHistoricalReceivers(snapshot, appFloorEpoch, pins) {
    const state = deserializeClientState(snapshot);
    if (pins.some((pin) => pin.unresolvedReceiverDependency))
        return { snapshot, receiverEpochs: undefined };
    const exact = new Set(pins.flatMap((pin) => pin.receiverEpoch === undefined ? [] : [pin.receiverEpoch]));
    for (const epoch of exact)
        retentionFloor(epoch, 0);
    // Every retained source can still process a competing Commit. Advancing one
    // child does not resolve the proposals staged on its selectable parent.
    for (const { proposal } of Object.values(state.unappliedProposals)) {
        if (proposal.proposalType !== defaultProposalTypes.psk ||
            !("psk" in proposal))
            continue;
        const psk = proposal.psk.preSharedKeyId;
        if ("pskEpoch" in psk &&
            bytesToHex(psk.pskGroupId) === bytesToHex(state.groupContext.groupId)) {
            const epoch = Number(psk.pskEpoch);
            retentionFloor(epoch, 0);
            exact.add(epoch);
        }
    }
    for (const epoch of exact) {
        if (BigInt(epoch) !== state.groupContext.epoch &&
            !state.historicalReceiverData.has(BigInt(epoch)))
            throw new Error("History retention: required receiver dependency absent");
    }
    for (const epoch of state.historicalReceiverData.keys()) {
        retentionFloor(Number(epoch), 0);
        if (epoch >= state.groupContext.epoch)
            throw new Error("History retention: invalid historical receiver epoch");
        if (epoch < BigInt(appFloorEpoch) && !exact.has(Number(epoch)))
            state.historicalReceiverData.delete(epoch);
    }
    return {
        snapshot: serializeClientState(state),
        receiverEpochs: [...state.historicalReceiverData.keys()]
            .map(Number)
            .sort((a, b) => a - b),
    };
}
