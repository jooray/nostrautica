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

export interface ChatPrewarmInput {
  /** The event naddr of the current route, if any (`eventNaddr(router.route)`). */
  routeNaddr: string | undefined;
  /** `eventShell.naddr` — the event the shell currently reflects. */
  shellNaddr: string | undefined;
  /** `eventShell.ctx` is loaded. */
  hasCtx: boolean;
  /** A signer is present. */
  hasSigner: boolean;
  /** `eventShell.showChat` — approved member AND chat enabled for this event. */
  showChat: boolean;
}

/**
 * Should the shell start the Marmot session in the background for the current
 * route? True exactly when the shell has settled on an approved member of a
 * chat-enabled event and reflects the route we're on.
 *
 * Enrolment is what this buys: the coordinator can only add a member once that
 * member's kind-30443 key package exists, and MLS gives the new member nothing
 * from before their Add. Waiting for the Chat tab therefore guarantees a first
 * visit to an empty room. Prewarming on any of the event's pages moves the Add
 * to approval time (or as close as the app being open allows), so the room is
 * already joined — and already receiving — by the time it is opened.
 */
export function shouldPrewarmChat(i: ChatPrewarmInput): boolean {
  if (!i.routeNaddr) return false;
  if (i.shellNaddr !== i.routeNaddr) return false; // shell still on another event
  return i.hasCtx && i.hasSigner && i.showChat;
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

/**
 * Can the Chat page open the room from state this device ALREADY holds, without
 * first asking the network "am I allowed in?"
 *
 * The page used to answer that question from scratch on every single open: a
 * relay round-trip for the event context, a full gift-wrap grant scan (paged
 * relay reads plus — on a remote signer — two NIP-46 round-trips per unprocessed
 * wrap), then a shell re-sync, and only then did it drop "Checking your access…"
 * (`chat.checking`). For a member opening chat for the tenth time that is seconds of
 * spinner to re-derive an answer that had not changed and could not change: the
 * thing that makes someone a chat member is an ECK sitting in THIS device's
 * keystore (`eventShell.showChat` = approved member + `chat=marmot`), which is a
 * local cryptographic fact, not a claim the relay has to confirm.
 *
 * So this is NOT an optimistic paint. It never widens who gets in — it is the
 * same predicate `evaluateChatGate` settles on, read from the shell that has
 * already resolved it for this event, instead of recomputed over the wire. When
 * the shell has NOT resolved a member (a deep link straight to /chat, a fresh
 * device, a genuine non-member), this returns false and the page pays for the
 * honest "checking" pass — a wrong-but-fast room is worse than a slow one.
 *
 * `hasCtx` matters because the room needs the event context (relays, coordinator)
 * to render at all; without a cached one there is a relay round-trip to make
 * anyway, so there is nothing to win by skipping the rest of the pass.
 */
export function canEnterChatFromLocalState(
  i: ChatGateInput & { hasCtx: boolean },
): boolean {
  if (!i.hasCtx) return false;
  // Exactly the gate's own "enter" conditions, minus `membershipKnown` — which
  // is only ever a statement about the page's own network pass having finished.
  return evaluateChatGate({ ...i, membershipKnown: true }) === "enter";
}
