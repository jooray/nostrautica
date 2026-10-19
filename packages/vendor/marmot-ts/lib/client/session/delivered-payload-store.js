import { getEventHash } from "applesauce-core/helpers/event";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decode, encode, mlsMessageDecoder, mlsMessageEncoder } from "../../vendor/ts-mls/index.js";
import { deserializeApplicationData } from "../../core/application-rumor.js";
import { framedEpoch } from "../../engine/wire-format.js";
import { defaultVerifyEvent, safeVerifyEvent } from "../verify.js";
/** No epoch secrets: only already-delivered payloads and their provenance. */
export function encodeDeliveredEvidence(evidence) {
    const pack = (entry) => ({
        ...entry,
        message: bytesToHex(encode(mlsMessageEncoder, entry.message)),
        payload: bytesToHex(entry.payload),
        commitDigest: entry.commitDigest && bytesToHex(entry.commitDigest),
    });
    return new TextEncoder().encode(JSON.stringify({
        version: 1,
        entries: evidence.entries.map(pack),
        pending: evidence.pending.map(pack),
    }));
}
/** Reject corrupt records rather than invent identity or branch attribution. */
export function decodeDeliveredEvidence(bytes, tree) {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (value.version !== 1 ||
        !Array.isArray(value.entries) ||
        !Array.isArray(value.pending))
        throw new Error("Invalid delivered evidence version/shape");
    const unpack = (entry) => {
        const hex = (value) => {
            if (typeof value !== "string" || !/^(?:[a-f0-9]{2})*$/.test(value))
                throw new Error("Invalid delivered evidence bytes");
            return value;
        };
        const node = tree.node(entry.stateTag);
        if (!node ||
            !Number.isSafeInteger(entry.epoch) ||
            entry.epoch < 0 ||
            entry.epoch !== node.epoch)
            throw new Error("Invalid delivered evidence branch");
        const payload = hexToBytes(hex(entry.payload));
        const rumorId = deserializeApplicationData(payload).id.toLowerCase();
        if (entry.rumorId !== rumorId ||
            entry.transportId !== entry.envelope?.id ||
            !/^[a-f0-9]{64}$/.test(entry.transportId) ||
            getEventHash(entry.envelope) !== entry.transportId ||
            entry.envelope.kind !== 445 ||
            !safeVerifyEvent(defaultVerifyEvent, entry.envelope))
            throw new Error("Invalid delivered evidence identity");
        const digest = node.edge?.commitDigest;
        if (entry.commitDigest !== (digest && bytesToHex(digest)))
            throw new Error("Invalid delivered evidence producing edge");
        const messageBytes = hexToBytes(hex(entry.message));
        const message = decode(mlsMessageDecoder, messageBytes);
        if (!message ||
            framedEpoch(message) !== BigInt(entry.epoch) ||
            bytesToHex(encode(mlsMessageEncoder, message)) !== entry.message)
            throw new Error("Invalid delivered evidence MLS message");
        return {
            epoch: entry.epoch,
            stateTag: entry.stateTag,
            envelope: entry.envelope,
            transportId: entry.transportId,
            rumorId,
            payload,
            message,
            commitDigest: digest,
        };
    };
    return {
        entries: value.entries.map(unpack),
        pending: value.pending.map(unpack),
    };
}
