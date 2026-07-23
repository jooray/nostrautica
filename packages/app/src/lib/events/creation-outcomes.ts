/**
 * Event-creation receipt (audit UX-A3 tail). Creating an event fans out into
 * several independent publications; the success screen must report each one's
 * real outcome instead of implying the whole thing succeeded. This models the
 * four separately-tracked outcomes, each retryable where a retry makes sense, so
 * the view is a pure render of state and the transitions are unit-testable.
 *
 *  - eventPublished:    the 31600/31923 itself (always ok once we have a result).
 *  - organizerEnrolled: the best-effort self-enrollment (skipped when unchecked).
 *  - coordinatorGrant:  the 21603 coordinator grant (skipped when none picked).
 *  - keysBackedUp:      the organizer key backup — "pending" until confirmed, and
 *                       "ok" for a remote signer that already holds the key.
 */
export type OutcomeState = "ok" | "failed" | "skipped" | "pending";

export type ReceiptStep = "eventPublished" | "organizerEnrolled" | "coordinatorGrant" | "keysBackedUp";

export interface CreationReceipt {
  eventPublished: OutcomeState;
  organizerEnrolled: OutcomeState;
  coordinatorGrant: OutcomeState;
  keysBackedUp: OutcomeState;
}

export interface ReceiptInputs {
  /** Did self-enrollment run, and did it fail? */
  enrollAttempted: boolean;
  enrollFailed: boolean;
  /** Was a coordinator picked, and did its attach fail? */
  coordinatorPicked: boolean;
  attachFailed: boolean;
  /** Fresh local key still needs a backup; a remote signer already holds it. */
  freshLocalKey: boolean;
  backupConfirmed: boolean;
}

export function buildReceipt(inputs: ReceiptInputs): CreationReceipt {
  return {
    eventPublished: "ok", // we only build a receipt once the event exists
    organizerEnrolled: !inputs.enrollAttempted
      ? "skipped"
      : inputs.enrollFailed
        ? "failed"
        : "ok",
    coordinatorGrant: !inputs.coordinatorPicked
      ? "skipped"
      : inputs.attachFailed
        ? "failed"
        : "ok",
    keysBackedUp: !inputs.freshLocalKey
      ? "ok" // remote signer holds the key — nothing to back up here
      : inputs.backupConfirmed
        ? "ok"
        : "pending",
  };
}

/** Apply a retry outcome for one step (success flips a failed step to ok). */
export function applyRetry(
  receipt: CreationReceipt,
  step: ReceiptStep,
  success: boolean,
): CreationReceipt {
  return { ...receipt, [step]: success ? "ok" : "failed" };
}

/** True when no step is in a "failed" state (pending backup is not a failure). */
export function allSettled(receipt: CreationReceipt): boolean {
  return (Object.values(receipt) as OutcomeState[]).every((s) => s !== "failed");
}

/** Steps that still need the organizer's attention (failed publications). */
export function failedSteps(receipt: CreationReceipt): ReceiptStep[] {
  return (Object.entries(receipt) as [ReceiptStep, OutcomeState][])
    .filter(([, s]) => s === "failed")
    .map(([k]) => k);
}
