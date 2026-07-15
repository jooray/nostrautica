/** @module @category Core - Inbound Processing */
/**
 * Inbound-processing vocabulary (Marmot v2 `protocol-core/inbound-processing.md`
 * + `foundation/errors.md`).
 *
 * Inbound processing turns transport bytes into Marmot protocol input and gives
 * each input a disposition. Transport delivery is evidence that bytes exist, not
 * that they define canonical group state — so order, timestamps, and transport
 * ids never decide an outcome. The protocol-visible result of processing an
 * input is its {@link Disposition}; an input that produces no application content
 * is classified into a shared {@link InputCategory}.
 */
/**
 * The shared input categories from `foundation/errors.md`. An input that does not
 * produce application content maps to one of these. These are protocol-level
 * outcome names; local APIs are not required to use these exact identifiers.
 */
export declare const inputCategories: {
    /** The same protocol input was already seen. */
    readonly duplicate: "duplicate";
    /** The input is the client's own already-accounted-for output. */
    readonly ownEcho: "own_echo";
    /** The input targets another account, device, group, or routing id. */
    readonly wrongRecipient: "wrong_recipient";
    /** The client has no group state that can process the input. */
    readonly unknownGroup: "unknown_group";
    /** The input is represented by the current canonical state. */
    readonly alreadyApplied: "already_applied";
    /** The input is from an epoch the client will not process. */
    readonly staleEpoch: "stale_epoch";
    /** Bytes failed the owning document's parser or length rules. */
    readonly invalidEncoding: "invalid_encoding";
    /** A required MLS, Nostr, or component signature check failed. */
    readonly invalidSignature: "invalid_signature";
    /** The group requires a feature the client does not understand. */
    readonly unsupportedRequiredFeature: "unsupported_required_feature";
    /** The sender or committer is not allowed to make the change. */
    readonly authorizationFailed: "authorization_failed";
    /** The client would need retained state it no longer has. */
    readonly missingHistory: "missing_history";
    /** Publication or delivery failed at the transport layer. */
    readonly transportRejected: "transport_rejected";
};
/** A shared input category value (the `snake_case` wire name). */
export type InputCategory = (typeof inputCategories)[keyof typeof inputCategories];
/**
 * The protocol-visible disposition emitted for an inbound message.
 *
 * - `accepted` — the input was applied to (or is consistent with) canonical state
 *   on the selected branch; for an MLS application message this also delivers a
 *   payload.
 * - `stale` — the input cannot affect the group; carries the {@link InputCategory}.
 * - `deferred` — the input cannot be processed yet but could become processable
 *   when more protocol bytes arrive; MUST be retried.
 * - `invalidated` — an MLS application message that decrypts only on a losing
 *   branch; reported, never delivered as accepted output.
 */
export type Disposition = {
    kind: "accepted";
} | {
    kind: "stale";
    category: InputCategory;
} | {
    kind: "deferred";
    reason: DeferredReason;
} | {
    kind: "invalidated";
};
/** Why an input was deferred (retry when the missing state becomes available). */
export declare const deferredReasons: {
    /** An MLS application message for a future candidate epoch. */
    readonly futureEpoch: "future_epoch";
    /** A child commit whose parent branch is not yet available. */
    readonly missingParent: "missing_parent";
    /** Input received while the group is in PendingPublish or Merging. */
    readonly groupBusy: "group_busy";
};
/** A deferred-input reason. */
export type DeferredReason = (typeof deferredReasons)[keyof typeof deferredReasons];
/**
 * Convergence outcome names (`PascalCase` in the spec) that map onto shared
 * `snake_case` {@link InputCategory} values.
 */
export declare const convergenceOutcomeToCategory: {
    /** A commit/state older than the retained anchor — needs history we dropped. */
    readonly BeyondAnchor: "missing_history";
    /** The required retained anchor is missing — needs history we dropped. */
    readonly MissingRetainedAnchor: "missing_history";
};
/** A convergence outcome name (`PascalCase`). */
export type ConvergenceOutcome = keyof typeof convergenceOutcomeToCategory;
/** Convenience constructors for dispositions. */
export declare const disposition: {
    accepted: () => Disposition;
    stale: (category: InputCategory) => Disposition;
    deferred: (reason: DeferredReason) => Disposition;
    invalidated: () => Disposition;
};
