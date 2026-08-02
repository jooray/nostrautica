import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { makeInviteProof, inviteHash, invitePolicyOf, INVITE_USES_UNLIMITED } from "@nostrautica/protocol";
import { Store } from "../store/db.js";
import { InviteChecker, evaluateEntitlement } from "./entitlement.js";

const coord = "31923:" + "a".repeat(64) + ":ev";

/** The published 31601 entries, keyed by hash, as the coordinator assembles them. */
function publish(invitePubkey: string, entry: { uses?: number; exp?: number } = {}) {
  return new Map([[inviteHash(invitePubkey), invitePolicyOf(entry)]]);
}

describe("invite entitlement (spec §6.5)", () => {
  it("grants a valid unused invite; second use falls back to manual queue", () => {
    const store = new Store();
    const checker = new InviteChecker(store);
    const inviteSk = generateSecretKey();
    const invitePub = getPublicKey(inviteSk);
    const published = publish(invitePub);

    const alice = getPublicKey(generateSecretKey());
    const proofA = makeInviteProof(inviteSk, coord, alice);
    const first = evaluateEntitlement([checker], {
      coordinate: coord, attendeePubkey: alice, invite: proofA, publishedInvites: published,
    }, 1);
    expect(first.grant).toBe(true);

    // A DIFFERENT attendee reuses the same code → not granted (manual queue).
    const bob = getPublicKey(generateSecretKey());
    const proofB = makeInviteProof(inviteSk, coord, bob);
    const second = evaluateEntitlement([checker], {
      coordinate: coord, attendeePubkey: bob, invite: proofB, publishedInvites: published,
    }, 2);
    expect(second.grant).toBe(false);
  });

  it("is idempotent for the same attendee (re-delivery of the same request)", () => {
    const store = new Store();
    const checker = new InviteChecker(store);
    const inviteSk = generateSecretKey();
    const published = publish(getPublicKey(inviteSk));
    const alice = getPublicKey(generateSecretKey());
    const proof = makeInviteProof(inviteSk, coord, alice);
    const req = { coordinate: coord, attendeePubkey: alice, invite: proof, publishedInvites: published };
    expect(evaluateEntitlement([checker], req, 1).grant).toBe(true);
    expect(evaluateEntitlement([checker], req, 2).grant).toBe(true); // same attendee, still granted
  });

  it("rejects an invite whose hash isn't published", () => {
    const store = new Store();
    const checker = new InviteChecker(store);
    const inviteSk = generateSecretKey();
    const alice = getPublicKey(generateSecretKey());
    const proof = makeInviteProof(inviteSk, coord, alice);
    const decision = evaluateEntitlement([checker], {
      coordinate: coord, attendeePubkey: alice, invite: proof, publishedInvites: new Map(),
    }, 1);
    expect(decision.grant).toBe(false);
  });

  it("admits every scanner of a shared code up to its cap, then queues the rest", () => {
    // The door-QR case: one code on a slide, everyone in the room scans it.
    const store = new Store();
    const checker = new InviteChecker(store);
    const inviteSk = generateSecretKey();
    const published = publish(getPublicKey(inviteSk), { uses: 3 });

    const granted = [1, 2, 3, 4].map((i) => {
      const pk = getPublicKey(generateSecretKey());
      return evaluateEntitlement(
        [checker],
        { coordinate: coord, attendeePubkey: pk, invite: makeInviteProof(inviteSk, coord, pk), publishedInvites: published },
        i,
      ).grant;
    });
    expect(granted).toEqual([true, true, true, false]);
  });

  it("never spends a second slot on a re-delivered join from the same attendee", () => {
    // The join handler re-runs on redelivery; a shared code must not be burnt
    // down by one attendee's retries.
    const store = new Store();
    const checker = new InviteChecker(store);
    const inviteSk = generateSecretKey();
    const published = publish(getPublicKey(inviteSk), { uses: 2 });
    const alice = getPublicKey(generateSecretKey());
    const req = {
      coordinate: coord,
      attendeePubkey: alice,
      invite: makeInviteProof(inviteSk, coord, alice),
      publishedInvites: published,
    };
    for (const t of [1, 2, 3, 4, 5]) expect(evaluateEntitlement([checker], req, t).grant).toBe(true);
    expect(store.inviteRedemptions(coord, getPublicKey(inviteSk))).toBe(1);

    const bob = getPublicKey(generateSecretKey());
    expect(
      evaluateEntitlement(
        [checker],
        { coordinate: coord, attendeePubkey: bob, invite: makeInviteProof(inviteSk, coord, bob), publishedInvites: published },
        6,
      ).grant,
    ).toBe(true); // the second slot was still there
  });

  it("keeps admitting on an unlimited code", () => {
    const store = new Store();
    const checker = new InviteChecker(store);
    const inviteSk = generateSecretKey();
    const published = publish(getPublicKey(inviteSk), { uses: INVITE_USES_UNLIMITED });
    for (let i = 0; i < 50; i++) {
      const pk = getPublicKey(generateSecretKey());
      expect(
        evaluateEntitlement(
          [checker],
          { coordinate: coord, attendeePubkey: pk, invite: makeInviteProof(inviteSk, coord, pk), publishedInvites: published },
          i + 1,
        ).grant,
      ).toBe(true);
    }
  });

  it("stops auto-approving past `exp`, without rejecting the person", () => {
    const store = new Store();
    const checker = new InviteChecker(store);
    const inviteSk = generateSecretKey();
    // Expiry is in unix SECONDS; `now` is milliseconds, like everywhere else here.
    const published = publish(getPublicKey(inviteSk), { uses: INVITE_USES_UNLIMITED, exp: 1_000 });
    const late = getPublicKey(generateSecretKey());
    const decision = evaluateEntitlement(
      [checker],
      { coordinate: coord, attendeePubkey: late, invite: makeInviteProof(inviteSk, coord, late), publishedInvites: published },
      1_001_000,
    );
    expect(decision.grant).toBe(false);
    expect(decision.reason).toContain("expired");
    // Not spent either — an expired code is a queue, not a rejection.
    expect(store.inviteRedemptions(coord, getPublicKey(inviteSk))).toBe(0);
  });

  it("treats an entry with no `uses` as single-use (what an older publisher meant)", () => {
    const store = new Store();
    const checker = new InviteChecker(store);
    const inviteSk = generateSecretKey();
    const published = publish(getPublicKey(inviteSk)); // no uses, no exp
    const a = getPublicKey(generateSecretKey());
    const b = getPublicKey(generateSecretKey());
    expect(
      evaluateEntitlement([checker], { coordinate: coord, attendeePubkey: a, invite: makeInviteProof(inviteSk, coord, a), publishedInvites: published }, 1).grant,
    ).toBe(true);
    expect(
      evaluateEntitlement([checker], { coordinate: coord, attendeePubkey: b, invite: makeInviteProof(inviteSk, coord, b), publishedInvites: published }, 2).grant,
    ).toBe(false);
  });

  it("no invite → manual queue", () => {
    const store = new Store();
    const checker = new InviteChecker(store);
    const decision = evaluateEntitlement([checker], {
      coordinate: coord, attendeePubkey: "b".repeat(64), publishedInvites: new Map(),
    }, 1);
    expect(decision.grant).toBe(false);
  });
});
