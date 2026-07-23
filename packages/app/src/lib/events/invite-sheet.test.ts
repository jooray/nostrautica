/**
 * Printable invite sheet (spec §13): only unused codes are rendered.
 */
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nsecEncode } from "nostr-tools/nip19";
import { invitePubkey, invitesForSheet } from "./invite-sheet.js";
import type { GeneratedInvite } from "./organizer.js";

function makeInvite(label: string): { invite: GeneratedInvite; pubkey: string } {
  const sk = generateSecretKey();
  return {
    pubkey: getPublicKey(sk),
    invite: { label, nsec: nsecEncode(sk), link: `https://x/#/e/naddr/join?code=${nsecEncode(sk)}` },
  };
}

describe("invitePubkey", () => {
  it("derives the invite key's pubkey from its nsec", () => {
    const { invite, pubkey } = makeInvite("invite-1");
    expect(invitePubkey(invite)).toBe(pubkey);
  });
  it("returns undefined for a malformed code", () => {
    expect(invitePubkey({ label: "x", nsec: "not-an-nsec", link: "" })).toBeUndefined();
  });
});

describe("invitesForSheet", () => {
  it("returns all codes when nothing is marked used", () => {
    const a = makeInvite("invite-1");
    const b = makeInvite("invite-2");
    expect(invitesForSheet([a.invite, b.invite])).toEqual([a.invite, b.invite]);
  });

  it("drops codes whose invite-pubkey has been redeemed", () => {
    const a = makeInvite("invite-1");
    const b = makeInvite("invite-2");
    const sheet = invitesForSheet([a.invite, b.invite], new Set([a.pubkey]));
    expect(sheet).toEqual([b.invite]);
  });
});
