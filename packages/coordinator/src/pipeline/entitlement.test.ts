import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { makeInviteProof, inviteHash } from "@nostrautica/protocol";
import { Store } from "../store/db.js";
import { InviteChecker, evaluateEntitlement } from "./entitlement.js";

const coord = "31923:" + "a".repeat(64) + ":ev";

describe("invite entitlement (spec §6.5)", () => {
  it("grants a valid unused invite; second use falls back to manual queue", () => {
    const store = new Store();
    const checker = new InviteChecker(store);
    const inviteSk = generateSecretKey();
    const invitePub = getPublicKey(inviteSk);
    const published = new Set([inviteHash(invitePub)]);

    const alice = getPublicKey(generateSecretKey());
    const proofA = makeInviteProof(inviteSk, coord, alice);
    const first = evaluateEntitlement([checker], {
      coordinate: coord, attendeePubkey: alice, invite: proofA, publishedInviteHashes: published,
    }, 1);
    expect(first.grant).toBe(true);

    // A DIFFERENT attendee reuses the same code → not granted (manual queue).
    const bob = getPublicKey(generateSecretKey());
    const proofB = makeInviteProof(inviteSk, coord, bob);
    const second = evaluateEntitlement([checker], {
      coordinate: coord, attendeePubkey: bob, invite: proofB, publishedInviteHashes: published,
    }, 2);
    expect(second.grant).toBe(false);
  });

  it("is idempotent for the same attendee (re-delivery of the same request)", () => {
    const store = new Store();
    const checker = new InviteChecker(store);
    const inviteSk = generateSecretKey();
    const published = new Set([inviteHash(getPublicKey(inviteSk))]);
    const alice = getPublicKey(generateSecretKey());
    const proof = makeInviteProof(inviteSk, coord, alice);
    const req = { coordinate: coord, attendeePubkey: alice, invite: proof, publishedInviteHashes: published };
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
      coordinate: coord, attendeePubkey: alice, invite: proof, publishedInviteHashes: new Set(),
    }, 1);
    expect(decision.grant).toBe(false);
  });

  it("no invite → manual queue", () => {
    const store = new Store();
    const checker = new InviteChecker(store);
    const decision = evaluateEntitlement([checker], {
      coordinate: coord, attendeePubkey: "b".repeat(64), publishedInviteHashes: new Set(),
    }, 1);
    expect(decision.grant).toBe(false);
  });
});
