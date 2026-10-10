/** @module @category Engine */
import type { MlsMessage } from "../vendor/ts-mls/index.js";
/**
 * One application payload delivered (yielded `processed` / `accepted`) on a
 * specific branch state. Remembered so that if a later convergence rewind
 * abandons the branch it decrypted on, the payload can be reported
 * `invalidated` (`protocol-core/inbound-processing.md`, `convergence.md`).
 */
export interface DeliveredAppPayload<TEnvelope> {
    /** Epoch of the state the payload decrypted against. */
    epoch: number;
    /** Hex confirmation tag of that state — its branch+epoch identity. */
    stateTag: string;
    envelope: TEnvelope;
    /** The MLS application message (encrypted wrapper). */
    message: MlsMessage;
    /** The decrypted Marmot app payload bytes, so a retraction can name it. */
    payload: Uint8Array;
}
/**
 * A bounded ledger of application payloads already delivered as `accepted`,
 * keyed by the branch state they decrypted on.
 *
 * Marmot v2 delivers app payloads eagerly — there is no settle-then-release
 * gate yet (that is B5) — so when a convergence fork rewind abandons a branch,
 * the payloads delivered on it MUST be retracted with an `invalidated`
 * notification. This ledger lets the engine find exactly those payloads on a
 * rewind.
 *
 * It holds no protocol state of its own; entries are pruned only below the
 * oldest state still named by retained history or the fork tree. A finite,
 * pruned tree can bound this ledger. With an unpruned full-history tree — and
 * especially `maxRewindCommits: Infinity` — correctness requires unbounded
 * retention until tree pruning exists. Mirrors the bookkeeping darkmatter does in
 * `distributed_convergence.rs` (`AppMessageInvalidated`).
 */
export declare class DeliveredPayloadLedger<TEnvelope> {
    #private;
    /** Number of remembered payloads. */
    get size(): number;
    /** Whether this exact MLS message is recorded against `stateTag`. */
    has(stateTag: string, message: MlsMessage): boolean;
    /** Retained transport envelopes used as witnesses by later fork passes. */
    envelopes(): TEnvelope[];
    /** Remembers a delivered application payload. */
    record(entry: DeliveredAppPayload<TEnvelope>): void;
    /**
     * Removes and returns the payloads abandoned by a rewind to a canonical
     * branch: those delivered strictly after `forkEpoch` whose delivery state is
     * not on the canonical chain (`canonicalTags`). Payloads that decrypted on
     * the canonical branch, and any at or below the fork epoch (shared history),
     * are retained.
     */
    invalidatedByRewind(forkEpoch: number, canonicalTags: ReadonlySet<string>): DeliveredAppPayload<TEnvelope>[];
    /**
     * Drops entries below the caller's tree-aware correctness horizon. The
     * engine supplies `min(retained anchor, oldest tree-node epoch)` so no
     * payload still nameable by a fork candidate loses its retraction record.
     */
    pruneBelow(epoch: number): void;
}
