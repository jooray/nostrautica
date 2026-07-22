/**
 * Pluggable entitlement checkers (spec §6.5, §12). Approvals are implemented as
 * entitlement checkers so ticketing (Cashu) bolts on without protocol changes —
 * it's just another checker beside `invite`.
 *
 * The `invite` checker is stateless-valid (hash membership + pubkey-bound sig)
 * AND first-come single-use, tracked locally. Single-use is eventually
 * consistent: duplicates fall back to the manual queue, never auto-reject
 * (IMPLEMENTATION_PLAN §3.12).
 */
import { isInviteValid, type InviteProof } from "@nostrautica/protocol";
import type { Store } from "../store/db.js";

export interface EntitlementRequest {
  coordinate: string;
  attendeePubkey: string;
  invite?: InviteProof;
  publishedInviteHashes: Set<string>;
}

export type EntitlementDecision =
  | { grant: true; reason: string }
  | { grant: false; reason: string };

export interface EntitlementChecker {
  readonly id: string;
  check(req: EntitlementRequest, now: number): EntitlementDecision;
}

/** Invite-code checker (spec §6.5). */
export class InviteChecker implements EntitlementChecker {
  readonly id = "invite";
  constructor(private readonly store: Store) {}

  check(req: EntitlementRequest, now: number): EntitlementDecision {
    if (!req.invite) return { grant: false, reason: "no invite proof" };
    const valid = isInviteValid(
      req.invite,
      req.publishedInviteHashes,
      req.coordinate,
      req.attendeePubkey,
    );
    if (!valid) return { grant: false, reason: "invalid invite proof" };
    // First-come single-use: claim the invite pubkey for this attendee.
    const claimed = this.store.claimInvite(
      req.coordinate,
      req.invite.invitePubkey,
      req.attendeePubkey,
      now,
    );
    if (!claimed) return { grant: false, reason: "invite already used → manual queue" };
    return { grant: true, reason: "valid unused invite" };
  }
}

/**
 * Evaluate a request against a checker chain. First checker to grant wins; if
 * none grant, the request goes to the manual queue, reported with the LAST
 * checker's own specific reason (not a generic one) — callers use this to
 * distinguish "no code presented" / "already used" (retrying changes nothing)
 * from "code doesn't validate against what we currently have cached" (worth
 * one bypass re-fetch — see coordinator.ts's handleJoin retry, audit COORD-29
 * follow-up). With zero checkers configured there's nothing to report, so
 * that case keeps a generic fallback.
 */
export function evaluateEntitlement(
  checkers: EntitlementChecker[],
  req: EntitlementRequest,
  now: number,
): EntitlementDecision {
  let last: EntitlementDecision = { grant: false, reason: "no checker granted → manual queue" };
  for (const checker of checkers) {
    last = checker.check(req, now);
    if (last.grant) return last;
  }
  return last;
}
