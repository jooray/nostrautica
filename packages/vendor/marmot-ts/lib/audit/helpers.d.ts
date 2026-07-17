import type { AuditEmitContext, AuditEpochState, AuditEventContext, AuditMessageArtifactKind, MarmotAuditEvent } from "./types.js";
export declare function auditNowMs(): number;
export declare function digestBytes(bytes: Uint8Array): string;
export declare function digestString(value: string): string;
export declare function toAuditBytes(value: Uint8Array | string): Uint8Array;
export declare function deriveAccountRef(accountId: Uint8Array | string): string;
export declare function deriveMemberRef(memberIdentity: Uint8Array | string): string;
export declare function deriveEngineId(accountId: Uint8Array | string, deviceId: Uint8Array | string): string;
export declare function auditEpochStateName(value: string): AuditEpochState;
export declare function messageArtifactKindFromNostrKind(kind: number | undefined): AuditMessageArtifactKind;
export declare function createAuditEvent(context: AuditEmitContext, seq: number, kind: MarmotAuditEvent["kind"], options?: {
    groupRef?: string;
    context?: AuditEventContext;
}): MarmotAuditEvent;
export declare function mergeAuditContexts(a: AuditEventContext | undefined, b: AuditEventContext | undefined): AuditEventContext | undefined;
export declare function errorDetail(error: unknown): string;
