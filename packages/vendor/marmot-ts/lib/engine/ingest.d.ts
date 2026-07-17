import { Debugger } from "debug";
import { type CiphersuiteImpl, type ClientState, type IncomingMessageCallback, MlsMessage, type ProcessMessageResult } from "ts-mls";
import { type DeferredReason } from "../core/inbound.js";
import type { RetainedHistoryStore } from "./retained-store.js";
import type { IngestResult, PeeledMessagePair } from "./types.js";
/** A message deferred this batch, remembered so terminal yields report it as
 * `deferred` (retryable) rather than `unreadable` (terminal/malformed). */
type DeferredEntry = {
    message: MlsMessage;
    reason: DeferredReason;
};
/** The applied outcome of a fork resolution, as the ingest loop consumes it. */
export type AppliedForkResolution<TEnvelope> = {
    outcome: "recovered";
    result: ProcessMessageResult;
    /**
     * App payloads abandoned by the rewind, to report as `invalidated` (M7).
     * Each carries the fork node (`tag`/`epoch`) it had decrypted against so
     * the retraction names its losing branch.
     */
    invalidated: {
        envelope: TEnvelope;
        message: MlsMessage;
        payload: Uint8Array;
        tag: string;
        epoch: number;
    }[];
} | {
    outcome: "superseded" | "skip";
};
/**
 * The engine-facing surface the ingest pipeline drives. State and lifecycle
 * mutation stay owned by the engine; the pipeline only reads/advances through
 * these hooks so the convergence rewind and `Unrecoverable` transition remain
 * the engine's responsibility.
 */
export interface IngestContext<TEnvelope> {
    ciphersuite: CiphersuiteImpl;
    peeler: {
        peelGroupMessages(envelopes: TEnvelope[], state: ClientState): Promise<{
            read: PeeledMessagePair<TEnvelope>[];
            unreadable: TEnvelope[];
        }>;
    };
    retained: RetainedHistoryStore;
    /** The rollback horizon (`maxRewindCommits`) from the active convergence policy. */
    maxRewindCommits: number;
    log: Debugger;
    getState(): ClientState;
    setState(state: ClientState): void;
    /**
     * Records an applied commit on the canonical branch: updates retained history
     * and the full-fork history tree. Replaces a direct `retained.record` so both
     * stay in lockstep, with the freshly-produced child captured pristine.
     */
    recordCommit(parentState: ClientState, message: MlsMessage, newState: ClientState): void;
    /**
     * Records that a proposal was staged onto the current state (its epoch and
     * confirmation tag are unchanged), so the history tree's node snapshot picks
     * up the new `unappliedProposals`.
     */
    recordProposalStaged(state: ClientState): void;
    /** Builds the admin-verification callback against the current state. */
    createAdminCallback(): IncomingMessageCallback;
    /** Resolves a fork and applies the rewind (state + lifecycle) on success. */
    resolveFork(forkEpoch: number, pool: MlsMessage[], encrypted: TEnvelope[], witnessEnvelopes: TEnvelope[]): Promise<AppliedForkResolution<TEnvelope>>;
    /**
     * Remembers an application payload delivered as `accepted` on the current
     * branch state, so a later rewind that abandons that branch can retract it
     * as `invalidated` (M7).
     */
    recordDeliveredAppPayload(epoch: number, stateTag: string, envelope: TEnvelope, message: MlsMessage, payload: Uint8Array): void;
    /** Drives the group to the terminal `Unrecoverable` lifecycle state. */
    toUnrecoverable(): void;
}
/**
 * Whether a decrypted application message is authentic: its inner Nostr event
 * id is canonical AND its `pubkey` matches the MLS-authenticated sender's
 * account identity (`foundation/identity.md`, `protocol-core/group-messaging.md`).
 * MLS authenticates *who* sent the bytes (the sender leaf); this binds the inner
 * author to that sender so a member can't forge another account's authorship.
 * A failure — including an unattributable sender (no leaf index) or a
 * non-conformant payload — is `invalid_encoding`; the message is dropped, never
 * delivered.
 */
export declare function isAuthenticApplicationMessage(result: ProcessMessageResult & {
    kind: "applicationMessage";
}, state: ClientState, log: Debugger, label: string): boolean;
/**
 * Ingests transport envelopes and applies MLS messages to group state
 * (Marmot v2 `protocol-core/inbound-processing.md`). Decrypts (retrying against
 * retained states), splits commits from non-commits, applies in-order commits,
 * routes past/future-epoch commits through convergence fork recovery, and
 * retries out-of-order messages only while a pass made progress.
 *
 * This is the engine's `message_processor/ingest` seam, extracted from
 * `MarmotGroupEngine` so the 400-line pipeline can be read and tested in
 * isolation from send and lifecycle.
 */
export declare function ingestEnvelopes<TEnvelope>(ctx: IngestContext<TEnvelope>, envelopes: TEnvelope[], options?: {
    retryCount?: number;
    maxRetries?: number;
    _errors?: Array<{
        envelope: TEnvelope;
        error: unknown;
    }>;
    _deferred?: Map<TEnvelope, DeferredEntry>;
    _decryptFailed?: Set<TEnvelope>;
}): AsyncGenerator<IngestResult<TEnvelope>>;
export {};
