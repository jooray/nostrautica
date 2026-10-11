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
import {
  inviteHash,
  isInviteValid,
  isLinked,
  membershipAuthorities,
  parseMemberOfTags,
  verifyMembershipProof,
  type EventConfig,
  type InvitePolicy,
  type InviteProof,
} from "@nostrautica/protocol";
import type { Store } from "../store/db.js";

export interface EntitlementRequest {
  coordinate: string;
  attendeePubkey: string;
  invite?: InviteProof;
  /**
   * The published 31601 entries, keyed by `h` — a Map rather than a Set because
   * each code now carries its own redemption cap and expiry. Membership is still
   * the validity test; the value decides how many may redeem and until when.
   */
  publishedInvites: ReadonlyMap<string, InvitePolicy>;
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
      req.publishedInvites,
      req.coordinate,
      req.attendeePubkey,
    );
    if (!valid) return { grant: false, reason: "invalid invite proof" };
    // A code published without `uses` is single-use, which is both the original
    // behaviour and what an older publisher meant by saying nothing.
    const policy = req.publishedInvites.get(inviteHash(req.invite.invitePubkey)) ?? { uses: 1 };
    // An expired code is not revoked — the organizer may still want these people,
    // they just no longer walk in unattended. Same landing place as no code at all.
    if (policy.exp !== undefined && Math.floor(now / 1000) > policy.exp) {
      return { grant: false, reason: "invite expired → manual queue" };
    }
    // First-come, up to the code's cap; idempotent for a re-delivered join.
    const claimed = this.store.claimInvite(
      req.coordinate,
      req.invite.invitePubkey,
      req.attendeePubkey,
      now,
      policy.uses,
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

/** What a link check needs of a 31600: the fields §15 reads. */
export type LinkConfig = Pick<EventConfig, "coordinator" | "parent" | "children">;

export interface MemberOfRequest {
  /** The community being joined (this coordinator serves it). */
  coordinate: string;
  attendeePubkey: string;
  /** The 21600's tags; `member_of` entries are parsed from them. */
  tags: string[][];
  /** The community's own newest-config `children`. */
  children: readonly string[];
}

export type MemberOfDecision =
  | { grant: true; reason: string; child: string }
  | { grant: false; reason: string };

const shortPk = (pk: string) => pk.slice(0, 8);
const shortCoord = (c: string) => shortPk(c.split(":")[1] ?? c);

/**
 * Membership-by-event checker (PROTOCOL-NIP.md §15.4). Async, unlike the invite
 * checker, because the child's own newest 31600 has to be read from relays: the child
 * may be served by another coordinator, or none, so nothing here assumes it is
 * installed locally. `fetchChildConfig` returns the child's NEWEST config (latest-wins,
 * authored by the child's E_id) or undefined when it cannot be had.
 *
 * Every failure is a manual-queue reason, never a rejection: a proof that fails today
 * (child config not yet propagated, link half-published) may be fine tomorrow, and the
 * organizer can still approve the person by hand.
 */
export class MemberOfChecker {
  readonly id = "member_of";
  constructor(private readonly fetchChildConfig: (child: string) => Promise<LinkConfig | undefined>) {}

  async check(req: MemberOfRequest): Promise<MemberOfDecision> {
    const proofs = parseMemberOfTags(req.tags);
    if (proofs.length === 0) return { grant: false, reason: "no member_of proof" };
    let last = "member_of proof invalid";
    for (const p of proofs) {
      const tag = `member_of ${shortCoord(p.child)}`;
      if (!req.children.includes(p.child)) {
        last = `${tag}: this community does not list that event as a child → manual queue`;
        continue;
      }
      let childCfg: LinkConfig | undefined;
      try {
        childCfg = await this.fetchChildConfig(p.child);
      } catch {
        childCfg = undefined;
      }
      if (!childCfg) {
        last = `${tag}: the event's config could not be fetched → manual queue`;
        continue;
      }
      if (!isLinked(req.coordinate, { children: [...req.children] }, p.child, childCfg)) {
        last = `${tag}: the event does not name this community as its parent → manual queue`;
        continue;
      }
      const authorities = membershipAuthorities(p.child, childCfg);
      if (!authorities.includes(p.by)) {
        last = `${tag}: signer ${shortPk(p.by)} is not an authority of the event → manual queue`;
        continue;
      }
      if (!verifyMembershipProof(p, req.coordinate, p.child, req.attendeePubkey, authorities)) {
        last = `${tag}: signature does not verify → manual queue`;
        continue;
      }
      return { grant: true, reason: tag, child: p.child };
    }
    return { grant: false, reason: last };
  }
}
