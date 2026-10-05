/** @module @category Engine */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
export function disbandTombstoneKey(groupIdHex) {
    return `${groupIdHex}/disband/terminal`;
}
/** Non-secret, scrubbed MLS shell used only to construct the terminal facade. */
export function disbandRegistryStateKey(groupIdHex) {
    return `${groupIdHex}/disband/registry-state`;
}
export function encodeDisbandTombstone(tombstone) {
    validateTombstone(tombstone);
    const stored = {
        version: 1,
        groupId: bytesToHex(tombstone.groupId),
        selectedEpoch: tombstone.selectedEpoch,
        commitDigest: bytesToHex(tombstone.commitDigest),
        actorPubkey: tombstone.actorPubkey,
        notificationState: tombstone.notificationState,
    };
    return new TextEncoder().encode(JSON.stringify(stored));
}
export function decodeDisbandTombstone(data) {
    let value;
    try {
        value = JSON.parse(new TextDecoder().decode(data));
    }
    catch {
        throw new Error("Invalid disband tombstone encoding");
    }
    if (!value || typeof value !== "object")
        throw new Error("Invalid disband tombstone record");
    const record = value;
    if (record.version !== 1 ||
        typeof record.groupId !== "string" ||
        typeof record.selectedEpoch !== "number" ||
        typeof record.commitDigest !== "string" ||
        typeof record.actorPubkey !== "string" ||
        (record.notificationState !== "pending" &&
            record.notificationState !== "delivered"))
        throw new Error("Invalid disband tombstone record");
    let tombstone;
    try {
        tombstone = {
            groupId: hexToBytes(record.groupId),
            selectedEpoch: record.selectedEpoch,
            commitDigest: hexToBytes(record.commitDigest),
            actorPubkey: record.actorPubkey,
            notificationState: record.notificationState,
        };
    }
    catch {
        throw new Error("Invalid disband tombstone record");
    }
    validateTombstone(tombstone);
    return tombstone;
}
function validateTombstone(tombstone) {
    if (tombstone.groupId.length === 0 ||
        !Number.isSafeInteger(tombstone.selectedEpoch) ||
        tombstone.selectedEpoch < 0 ||
        tombstone.commitDigest.length !== 32 ||
        !/^[0-9a-f]{64}$/i.test(tombstone.actorPubkey) ||
        (tombstone.notificationState !== "pending" &&
            tombstone.notificationState !== "delivered"))
        throw new Error("Invalid disband tombstone record");
}
