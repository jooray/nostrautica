import { Debugger } from "debug";
import { type CiphersuiteImpl, type ClientState, type IncomingMessageCallback, MlsMessage, type ProcessMessageResult } from "../vendor/ts-mls/index.js";
import { type DeferredReason } from "../core/inbound.js";
import type { RejectedForkCandidate } from "./fork-recovery.js";
import type { RetainedHistoryStore } from "./retained-store.js";
import { type StateNotification } from "./state-notifications.js";
import type { DisbandCandidateEvidence, IngestResult, PeeledMessagePair } from "./types.js";
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
     * The winning branch's tip commit MLS message, when the winner chain
     * applied at least one commit to reach it (D-10/D-12) — lets the ingest
     * loop attribute a `selfRemoved` notification to the exact commit that
     * produced the `removedFromGroup` tombstone when the rewind lands on
     * it. `undefined` only when the winner tip is the fork root itself (no
     * chain applied), which never coincides with a fresh removal.
     */
    tipCommitMessage: MlsMessage | undefined;
    /**
     * The {@link StateNotification}s derived from the WHOLE applied winner
     * chain (D-10/D-11) — one derivation per `ChainLink`, in chain order,
     * concatenated. A rewind that adopts an N-commit branch applies N
     * commits, so reporting only the tip's diff would silently drop every
     * intermediate commit's membership/component changes (CR-07). Each
     * entry stays attributed to the commit digest that produced it, so the
     * caller can still group by commit.
     *
     * Computed and ledger-recorded by `#applyForkResolution` — the same
     * shared rewind-apply path used by both pool-replay recovery and
     * tree-fed re-convergence — so every one of them is withdrawable by a
     * later rewind. `undefined` when the winner tip is the fork root itself
     * (no chain applied, mirroring `tipCommitMessage`).
     */
    notifications: StateNotification[] | undefined;
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
    /**
     * Notifications withdrawn because the commit(s) that produced them were
     * superseded by this rewind (D-11, CONV-03). Flat — not yet grouped by
     * producing commit digest; the caller groups via
     * {@link groupWithdrawnNotificationsByCommit} before yielding
     * `stateInvalidated` results, since a rewind may supersede more than one
     * commit at once.
     */
    withdrawnNotifications: StateNotification[];
    /** Present only when canonical selection chose authenticated disband evidence. */
    selectedTerminal?: DisbandCandidateEvidence;
    /**
     * Pooled candidates refused against their parent (WR-01), reported as
     * `rejected` rather than `past-epoch`.
     */
    rejected?: RejectedForkCandidate[];
} | {
    outcome: "superseded" | "skip";
    rejected?: RejectedForkCandidate[];
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
    /** True only for canonical protocol disband; Unrecoverable is not terminal. */
    isDisbanded?: () => boolean;
    setState(state: ClientState): void;
    /**
     * Records an applied commit on the canonical branch: updates retained history
     * and the full-fork history tree. Replaces a direct `retained.record` so both
     * stay in lockstep, with the freshly-produced child captured pristine.
     */
    recordCommit(parentState: ClientState, message: MlsMessage, newState: ClientState): void;
    /** Retains a fully validated terminal edge without advancing canonical state. */
    admitDisbandCandidate(parentState: ClientState, message: MlsMessage, resultingState: ClientState, evidence: DisbandCandidateEvidence): void;
    /**
     * Records that a proposal was staged onto the current state (its epoch and
     * confirmation tag are unchanged), so the history tree's node snapshot picks
     * up the new `unappliedProposals`.
     */
    recordProposalStaged(state: ClientState): void;
    /**
     * Builds the admin-verification callback against `state` — the exact parent
     * the message is about to be processed on (CR-01). Never build it once and
     * reuse it across messages: a commit earlier in the batch can change the
     * admin set or the ratchet tree the next one must be authorized against.
     */
    createAdminCallback(state: ClientState): IncomingMessageCallback;
    /** Resolves a fork and applies the rewind (state + lifecycle) on success. */
    resolveFork(forkEpoch: number, pool: MlsMessage[], encrypted: TEnvelope[], witnessEnvelopes: TEnvelope[]): Promise<AppliedForkResolution<TEnvelope>>;
    /**
     * Remembers an application payload delivered as `accepted` on the current
     * branch state, so a later rewind that abandons that branch can retract it
     * as `invalidated` (M7).
     */
    recordDeliveredAppPayload(epoch: number, stateTag: string, envelope: TEnvelope, message: MlsMessage, payload: Uint8Array): void;
    /**
     * Records the {@link StateNotification}s derived from an accepted commit,
     * keyed by its `commitDigest` (D-10/D-11), so a later rewind that supersedes
     * this commit can withdraw exactly these notifications.
     */
    recordStateNotifications(digest: Uint8Array, epoch: number, notifications: StateNotification[]): void;
    /** Drives the group to the terminal `Unrecoverable` lifecycle state. */
    toUnrecoverable(): void;
    /**
     * Content-derived inbound dedup (`inbound-processing.md`; reference
     * `seen_message_ids` / `sent_message_ids`). Keyed on {@link contentDedupId} so
     * the same MLS message re-wrapped in a fresh transport envelope is recognized
     * across sources and restarts-within-process.
     */
    dedup: {
        /**
         * Classifies a peeled message against prior history: `duplicate` (this
         * content was already terminally processed), `own-echo` (our own send
         * replayed back), or `undefined` (fresh — process it).
         */
        classify(message: MlsMessage): "duplicate" | "own-echo" | undefined;
        /** Records a content id as seen, once the message reaches a terminal apply. */
        remember(message: MlsMessage): void;
    };
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
 *
 * The sender leaf index refers to the ratchet tree of the epoch the message
 * was sent in. For a message from a past epoch that tree is the retained
 * `historicalReceiverData` entry, not `state.ratchetTree`: the sender may have
 * been removed (or the leaf reused) since. Pass `messageEpoch` so the right
 * tree is used; MDK reads the credential the same way (OpenMLS
 * `ProcessedMessage::credential`, `cgka-engine/src/identity.rs`).
 */
export declare function isAuthenticApplicationMessage(result: ProcessMessageResult & {
    kind: "applicationMessage";
}, state: ClientState, log: Debugger, label: string, messageEpoch?: bigint): boolean;
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
