import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { makeMembershipProof } from "@nostrautica/protocol";
import { MemberOfChecker } from "./entitlement.js";

describe("MemberOfChecker (§15.4)", () => {
  const eidSk = generateSecretKey();
  const coordSk = generateSecretKey();
  const parent = "31612:" + "b".repeat(64) + ":community";
  const child = "31923:" + getPublicKey(eidSk) + ":meetup";
  const alice = getPublicKey(generateSecretKey());
  const tags = (p: { by: string; sig: string }) => [["member_of", child, p.by, p.sig]];
  const cfg = { coordinator: getPublicKey(coordSk), parent, children: undefined };

  it("grants a coordinator- or E_id-signed proof over a two-sided link", async () => {
    const checker = new MemberOfChecker(async () => cfg);
    for (const sk of [coordSk, eidSk]) {
      const d = await checker.check({
        coordinate: parent,
        attendeePubkey: alice,
        tags: tags(makeMembershipProof(sk, parent, child, alice)),
        children: [child],
      });
      expect(d.grant).toBe(true);
    }
  });

  it("queues with a specific reason when any condition fails", async () => {
    const proof = makeMembershipProof(coordSk, parent, child, alice);
    const base = { coordinate: parent, attendeePubkey: alice, tags: tags(proof), children: [child] };
    const ok = new MemberOfChecker(async () => cfg);
    expect((await ok.check({ ...base, tags: [] })).reason).toBe("no member_of proof");
    expect((await ok.check({ ...base, children: [] })).reason).toMatch(/does not list/);
    expect((await new MemberOfChecker(async () => undefined).check(base)).reason).toMatch(/could not be fetched/);
    expect(
      (await new MemberOfChecker(async () => { throw new Error("relay down"); }).check(base)).grant,
    ).toBe(false);
    expect(
      (await new MemberOfChecker(async () => ({ ...cfg, parent: undefined })).check(base)).reason,
    ).toMatch(/does not name this community/);
    expect(
      (await new MemberOfChecker(async () => ({ ...cfg, coordinator: getPublicKey(generateSecretKey()) })).check(base)).reason,
    ).toMatch(/not an authority/);
    expect(
      (await ok.check({ ...base, attendeePubkey: getPublicKey(generateSecretKey()) })).reason,
    ).toMatch(/does not verify/);
  });
});
