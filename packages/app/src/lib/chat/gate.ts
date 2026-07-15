/**
 * Pure decision for the Marmot chat page's membership gate (Bug 3).
 *
 * The viewer's role (attendee/organizer vs not) is resolved asynchronously by
 * `eventShell.sync()` — a roster/ECK-grant decrypt that runs decoupled from the
 * chat page's own mount. A one-shot check races that resolve and can permanently
 * strand an approved attendee on "not a member yet" even after the coordinator's
 * MLS Add succeeded (`docs/MARMOT-CHAT-E2E-2026-07-16.md`, Bug 3).
 *
 * This function encodes the gate so it is unit-testable in isolation: it must
 * NEVER settle "unavailable" while membership is still unknown. Show "loading"
 * until the shell has genuinely settled for THIS event; only then decide member
 * (`enter`) vs not (`unavailable`). Callers drive it reactively, so a late-
 * resolving membership transitions loading → enter instead of latching negative.
 */
export type ChatGate = "loading" | "unavailable" | "enter";

export interface ChatGateInput {
  /** Our own resolve pass (grant fetch + shell re-sync) has completed. */
  membershipKnown: boolean;
  /** `eventShell.naddr` — the event the shell currently reflects. */
  shellNaddr: string | undefined;
  /** The event this page is for. */
  naddr: string;
  /** `eventShell.loading` — a sync is in flight. */
  loading: boolean;
  /** `eventShell.showChat` — member AND chat enabled for this event. */
  showChat: boolean;
  /** A signer is present (no signer ⇒ can't be a chat member). */
  hasSigner: boolean;
}

export function evaluateChatGate(i: ChatGateInput): ChatGate {
  // Membership is UNKNOWN until our resolve pass has run AND the shell reflects
  // THIS event and isn't mid-sync. Until then keep loading — never latch a
  // negative from a stale or still-resolving shell state.
  if (!i.membershipKnown || i.shellNaddr !== i.naddr || i.loading) return "loading";
  // Genuinely known now: decide member vs not.
  if (!i.hasSigner || !i.showChat) return "unavailable";
  return "enter";
}
