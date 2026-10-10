/** @module @category Engine */
export function disbandRequestKey(groupIdHex) {
    return `${groupIdHex}/disband/request`;
}
export function disbandConvergenceKey(groupIdHex) {
    return `${groupIdHex}/disband/convergence`;
}
export function encodeDisbandConvergence(record) {
    return new TextEncoder().encode(JSON.stringify({ version: 1, ...record }));
}
export function decodeDisbandConvergence(data) {
    let value;
    try {
        value = JSON.parse(new TextDecoder().decode(data));
    }
    catch {
        throw new Error("Invalid disband convergence encoding");
    }
    const record = value;
    if (!record ||
        record.version !== 1 ||
        !Number.isSafeInteger(record.generation) ||
        !Number.isSafeInteger(record.baseEpoch) ||
        typeof record.openedAtWallMs !== "number" ||
        typeof record.deadlineWallMs !== "number" ||
        typeof record.lastRelevantInputWallMs !== "number" ||
        !Array.isArray(record.candidates))
        throw new Error("Invalid disband convergence record");
    for (const candidate of record.candidates) {
        if (!/^[0-9a-f]{64}$/i.test(candidate.commitDigest) ||
            !/^[0-9a-f]{64}$/i.test(candidate.actorPubkey) ||
            !Number.isSafeInteger(candidate.sourceEpoch) ||
            typeof candidate.parentTag !== "string" ||
            typeof candidate.childTag !== "string" ||
            typeof candidate.commitMessage !== "string" ||
            typeof candidate.resultingState !== "string" ||
            !/^[0-9a-f]*$/i.test(candidate.commitMessage) ||
            !/^[0-9a-f]*$/i.test(candidate.resultingState))
            throw new Error("Invalid disband convergence record");
    }
    return record;
}
export function encodeDisbandRequest(request) {
    return new TextEncoder().encode(JSON.stringify({ version: 1, ...request }));
}
export function decodeDisbandRequest(data) {
    let value;
    try {
        value = JSON.parse(new TextDecoder().decode(data));
    }
    catch {
        throw new Error("Invalid disband request encoding");
    }
    if (!value || typeof value !== "object")
        throw new Error("Invalid disband request record");
    const record = value;
    if (record.version !== 1 ||
        typeof record.requestedAtMs !== "number" ||
        !Number.isFinite(record.requestedAtMs) ||
        (record.lastPreparedEpoch !== null &&
            (typeof record.lastPreparedEpoch !== "number" ||
                !Number.isSafeInteger(record.lastPreparedEpoch) ||
                record.lastPreparedEpoch < 0)))
        throw new Error("Invalid disband request record");
    if (record.status === "pending") {
        return {
            status: "pending",
            requestedAtMs: record.requestedAtMs,
            lastPreparedEpoch: record.lastPreparedEpoch,
        };
    }
    if (record.status === "failed" &&
        (record.reason === "NoLongerMember" || record.reason === "NoLongerAdmin") &&
        record.lastPreparedEpoch === null) {
        return {
            status: "failed",
            reason: record.reason,
            requestedAtMs: record.requestedAtMs,
            lastPreparedEpoch: null,
        };
    }
    throw new Error("Invalid disband request record");
}
