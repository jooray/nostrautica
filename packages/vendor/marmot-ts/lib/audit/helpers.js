/** @module @category Audit */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { MARMOT_AUDIT_SCHEMA_VERSION } from "./types.js";
export function auditNowMs() {
    return Date.now();
}
export function digestBytes(bytes) {
    return bytesToHex(sha256(bytes));
}
export function digestString(value) {
    return digestBytes(utf8ToBytes(value));
}
export function toAuditBytes(value) {
    return typeof value === "string" ? utf8ToBytes(value) : value;
}
function taggedRef(tag, value) {
    const bytes = toAuditBytes(value);
    const input = new Uint8Array(tag.length + bytes.length);
    input.set(utf8ToBytes(tag));
    input.set(bytes, tag.length);
    return bytesToHex(sha256(input).slice(0, 16));
}
export function deriveAccountRef(accountId) {
    return taggedRef("marmot-audit-account-ref/v1", accountId);
}
export function deriveMemberRef(memberIdentity) {
    return taggedRef("marmot-audit-member-ref/v1", memberIdentity);
}
export function deriveEngineId(accountId, deviceId) {
    const account = toAuditBytes(accountId);
    const device = toAuditBytes(deviceId);
    const tag = utf8ToBytes("marmot-audit-engine-id/v2");
    const input = new Uint8Array(tag.length + account.length + device.length);
    input.set(tag);
    input.set(account, tag.length);
    input.set(device, tag.length + account.length);
    return bytesToHex(sha256(input).slice(0, 16));
}
export function auditEpochStateName(value) {
    switch (value) {
        case "Stable":
            return "stable";
        case "PendingPublish":
            return "pending_publish";
        case "Merging":
            return "merging";
        case "Recovering":
            return "recovering";
        case "Unrecoverable":
            return "unrecoverable";
        default:
            throw new Error(`Unknown Marmot group lifecycle state: ${value}`);
    }
}
export function messageArtifactKindFromNostrKind(kind) {
    switch (kind) {
        case 444:
            return "welcome";
        case 445:
            return "unknown";
        default:
            return "unknown";
    }
}
export function createAuditEvent(context, seq, kind, options) {
    const eventContext = mergeAuditContexts(context.source ? { source: context.source } : undefined, options?.context);
    return {
        schema_version: MARMOT_AUDIT_SCHEMA_VERSION,
        seq,
        wall_time_ms: context.now(),
        recorder_session_id: context.recorderSessionId,
        audit_data_mode: context.dataMode,
        account_ref: context.accountRef,
        engine_id: context.engineId,
        group_ref: options?.groupRef,
        context: eventContext,
        kind,
    };
}
export function mergeAuditContexts(a, b) {
    if (!a)
        return b;
    if (!b)
        return a;
    return {
        ...a,
        ...b,
        human_action: b.human_action ?? a.human_action,
        transport: b.transport ?? a.transport,
        engine: b.engine ?? a.engine,
        group: b.group ?? a.group,
        convergence: b.convergence ?? a.convergence,
        source: b.source ?? a.source,
    };
}
export function errorDetail(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
//# sourceMappingURL=helpers.js.map