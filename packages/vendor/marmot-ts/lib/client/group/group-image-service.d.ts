import type { ClientState } from "../../vendor/ts-mls/index.js";
import { type GroupImageSource, type GroupImageSnapshotIdentity } from "../../core/group-image.js";
import { type GroupImageTransport, type GroupImageTransportRequest, type GroupImageTransportResponse } from "./group-image-transport.js";
import type { GroupPublishResult } from "../session/group-effects.js";
export interface GroupImageProfile {
    endpoints?: readonly string[];
    resolveEndpoints?: (source: GroupImageSource, signal: AbortSignal) => Promise<readonly string[]>;
    transport?: GroupImageTransport;
    maxDownloadBytes?: number;
    maxUploadBytes?: number;
    maxDescriptorBytes?: number;
    maxDiagnosticBytes?: number;
    maxEndpointCandidates?: number;
    deadlineMs?: number;
    /** Called again for every request and before delivery; false refuses contact. */
    contactPolicy?: GroupImageContactPolicy;
}
export type GroupImageContactPolicy = (request: {
    url: string;
    method: "GET" | "PUT";
}, signal: AbortSignal) => boolean | Promise<boolean>;
/** @internal Complete compatibility tuple; never weaken a caller via reuse. */
export interface EffectiveGroupImageReadProfile {
    endpoints: readonly string[];
    resolverOutcome: "configured" | "resolved";
    transport: GroupImageTransport;
    contactPolicy?: GroupImageContactPolicy;
    authorization: readonly boolean[];
    maxDownloadBytes: number;
    maxUploadBytes: number;
    maxDescriptorBytes: number;
    maxDiagnosticBytes: number;
    maxEndpointCandidates: number;
    deadlineMs: number;
    /** Provenance for future cache entries and in-flight operations. */
    compatibilityKey: string;
}
/** @internal Evaluate this caller before any cache lookup or shared admission. */
export declare function effectiveGroupImageReadProfile(profile: GroupImageProfile, source: Extract<GroupImageSource, {
    kind: "blossom";
}>, signal: AbortSignal): Promise<EffectiveGroupImageReadProfile>;
/** @internal One budget including resolver, policy, transport and body reading. */
export declare function withGroupImageBudget<T>(profile: GroupImageProfile, options: GroupImageOperationOptions, operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
export type GroupImageUnavailableReason = "no-image" | "url-selected" | "endpoint-absent" | "missing-blob" | "contact-denied" | "byte-limit" | "deadline" | "transport" | "invalid-response" | "hash-mismatch" | "aead-failure" | "cancelled" | "stale" | "closed";
export type GroupImageReadResult = {
    kind: "available";
    bytes: Uint8Array;
    mediaType: string;
    snapshotIdentity: GroupImageSnapshotIdentity;
} | {
    kind: "unavailable";
    reason: GroupImageUnavailableReason;
};
export interface GroupImageOperationOptions {
    signal?: AbortSignal;
}
export type GroupImageMutationResult = {
    kind: "published";
    publications: GroupPublishResult[];
} | {
    kind: "unavailable";
    reason: GroupImageUnavailableReason;
};
export type GroupImageReplacementResult = GroupImageMutationResult;
export type GroupImageClearResult = GroupImageMutationResult;
export declare function groupImageLimit(value: number | undefined, fallback: number, maximum?: number): number;
export declare function groupImageEndpoints(profile: GroupImageProfile, source: GroupImageSource, signal: AbortSignal): Promise<string[]>;
/** Deadline also covers custom transports that do not settle after abort. */
export declare function requestGroupImage(profile: GroupImageProfile, request: Omit<GroupImageTransportRequest, "signal" | "deadlineMs">, options?: GroupImageOperationOptions): Promise<GroupImageTransportResponse>;
export declare function groupImageUnavailable(error: unknown): GroupImageReadResult & {
    kind: "unavailable";
};
export declare class GroupImageService {
    private readonly options;
    private readonly inFlight;
    private readonly activeReads;
    private readonly plaintext;
    private readonly cache;
    private cacheBytes;
    private readonly lifetime;
    private readonly maxCacheEntries;
    private readonly maxCacheBytes;
    private readonly maxActiveReads;
    constructor(options: {
        getState: () => ClientState;
        /** @internal Canonical snapshots retained by the session. */
        getRetainedStates?: () => Iterable<ClientState>;
        isClosed: () => boolean;
        /** Verified in-memory entries, default 16; zero disables caching. */
        maxCacheEntries?: number;
        /** Total cached plaintext bytes, default 20 MiB; zero disables caching. */
        maxCacheBytes?: number;
        /** Concurrent physical reads, default four. */
        maxActiveReads?: number;
    });
    /** Image lifetime, also used by manager-owned uploads and identity reads. */
    get closedSignal(): AbortSignal;
    /** Release owned image work and plaintext on group teardown. Idempotent. */
    close(): void;
    /** @internal Release detached owned copies after successful session persistence. */
    retireRetained(branchStates?: Iterable<ClientState>): void;
    private forget;
    private isClosed;
    private remember;
    source(): GroupImageSource;
    private current;
    private fetch;
    private deliver;
    read(profile: GroupImageProfile, options?: GroupImageOperationOptions): Promise<GroupImageReadResult>;
}
