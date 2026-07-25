/**
 * Printable invite sheet (spec §13): only unused codes are rendered.
 */
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nsecEncode } from "nostr-tools/nip19";
import { inviteHash } from "@nostrautica/protocol";
import { invitePubkey, invitesForSheet, redeemedInvitePubkeys } from "./invite-sheet.js";
import type { InviteUsage } from "./invite-export.js";
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

/**
 * The hash↔pubkey bridge between the redemption report and this filter. The door
 * case: a batch is generated, the sheet is displayed, walk-ins scan it, and the
 * organizer re-opens the sheet expecting the spent codes to be gone.
 */
describe("redeemedInvitePubkeys", () => {
  /** A used-set as invite-export records it: keyed by sha256(invite-pubkey). */
  function usedSet(...pubkeys: string[]): InviteUsage {
    const out: InviteUsage = {};
    for (const pk of pubkeys) out[inviteHash(pk)] = { at: 1700000000, pubkey: "a".repeat(64) };
    return out;
  }

  it("maps a redeemed code's hash back to its invite PUBKEY", () => {
    const a = makeInvite("invite-1");
    // Not the hash: the returned set is consumed by invitesForSheet, which keys on
    // pubkeys. Returning hashes would match nothing and filter nothing, silently.
    expect([...redeemedInvitePubkeys([a.invite], usedSet(a.pubkey))]).toEqual([a.pubkey]);
    expect(redeemedInvitePubkeys([a.invite], usedSet(a.pubkey)).has(inviteHash(a.pubkey))).toBe(
      false,
    );
  });

  it("leaves a code the used-set says nothing about alone", () => {
    const a = makeInvite("invite-1");
    const b = makeInvite("invite-2");
    expect(redeemedInvitePubkeys([a.invite, b.invite], usedSet(a.pubkey))).toEqual(
      new Set([a.pubkey]),
    );
  });

  it("filters nothing on an empty or absent used-set (positive evidence only)", () => {
    const a = makeInvite("invite-1");
    // `{}` is the state before the first report refresh lands; `undefined` is a
    // caller with no report at all. Neither may shorten the sheet.
    expect(redeemedInvitePubkeys([a.invite], {})).toEqual(new Set());
    expect(redeemedInvitePubkeys([a.invite], undefined)).toEqual(new Set());
  });

  it("never includes a code whose nsec won't decode", () => {
    const bad: GeneratedInvite = { label: "x", nsec: "not-an-nsec", link: "" };
    const a = makeInvite("invite-1");
    expect(redeemedInvitePubkeys([bad, a.invite], usedSet(a.pubkey))).toEqual(
      new Set([a.pubkey]),
    );
  });

  it("end to end: a scanned code drops off the sheet, the rest stay", () => {
    const a = makeInvite("invite-1");
    const b = makeInvite("invite-2");
    const c = makeInvite("invite-3");
    const all = [a.invite, b.invite, c.invite];
    // Nothing redeemed yet — the sheet the organizer first prints is complete.
    expect(invitesForSheet(all, redeemedInvitePubkeys(all, {}))).toEqual(all);
    // Walk-ins scan invite-1 and invite-3 over the next hour.
    const used = usedSet(a.pubkey, c.pubkey);
    expect(invitesForSheet(all, redeemedInvitePubkeys(all, used))).toEqual([b.invite]);
  });
});
