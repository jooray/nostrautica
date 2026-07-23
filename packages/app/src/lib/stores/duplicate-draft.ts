/**
 * Hand-off for a duplicate-event prefill (spec §13). The "Duplicate event" action
 * stashes a prefill here and navigates to Create, which takes it on mount. Same
 * one-shot set/take pattern as the talk-edit draft — in-memory only, so a stale
 * config never lingers or gets persisted anywhere identity-bearing.
 */
import type { DuplicatePrefill } from "$lib/events/duplicate.js";

let pending: DuplicatePrefill | null = null;

/** Stash a prefill for the create form to pick up. */
export function setDuplicateDraft(prefill: DuplicatePrefill): void {
  pending = prefill;
}

/** Take (and clear) the pending prefill, or null if none. */
export function takeDuplicateDraft(): DuplicatePrefill | null {
  const p = pending;
  pending = null;
  return p;
}
