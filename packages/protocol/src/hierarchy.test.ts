import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { buildEventConfig, configCoordinate, configForSpace, parseEventConfig, type EventConfig } from "./config.js";
import { makeCoordinate } from "./coordinate.js";
import { KIND_COMMUNITY } from "./kinds.js";
import { keyGrantContentSchema } from "./schemas.js";
import {
  MAX_CHILDREN,
  isLinked,
  makeMembershipProof,
  memberOfTag,
  membershipAuthorities,
  parseMemberOfTags,
  verifyMembershipProof,
} from "./hierarchy.js";

const hex = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

function base(eid: string, d: string): EventConfig {
  return {
    d, eidPubkey: eid, inbox: hex(1), relays: [], chatRelays: [], blossom: [], maxVideoSec: 90, maxTalkSec: 900,
    matching: "on", matchVisibility: "pair", approval: "manual", eck: 1, nostrContext: 0, lang: "en", talks: "off", chat: [],
  };
}

describe("space hierarchy (§15)", () => {
  const commSk = generateSecretKey();
  const eventSk = generateSecretKey();
  const coordSk = generateSecretKey();
  const community = makeCoordinate(getPublicKey(commSk), "meetups", KIND_COMMUNITY);
  const meetup = makeCoordinate(getPublicKey(eventSk), "meetup-12");
  const attendee = getPublicKey(generateSecretKey());

  it("round-trips parent and child tags, and omits them when unused", () => {
    const child = { ...base(getPublicKey(eventSk), "meetup-12"), parent: community };
    const parent = { ...base(getPublicKey(commSk), "meetups"), children: [meetup] };
    expect(parseEventConfig(child.eidPubkey, buildEventConfig(child).tags).parent).toBe(community);
    expect(parseEventConfig(parent.eidPubkey, buildEventConfig(parent).tags).children).toEqual([meetup]);
    const plain = buildEventConfig(base(getPublicKey(eventSk), "x")).tags;
    expect(plain.some((t) => t[0] === "parent" || t[0] === "child")).toBe(false);
  });

  it("refuses to build a malformed hierarchy, and parses one fail-soft", () => {
    expect(() => buildEventConfig({ ...base(hex(2), "x"), parent: meetup })).toThrow();
    expect(() => buildEventConfig({ ...base(hex(2), "x"), children: [community] })).toThrow();
    const many = Array.from({ length: MAX_CHILDREN + 1 }, (_, i) => makeCoordinate(hex(3), `e${i}`));
    expect(() => buildEventConfig({ ...base(hex(2), "x"), children: many })).toThrow();
    const parsed = parseEventConfig(hex(2), [
      ["d", "x"], ["v", "2"], ["inbox", hex(1)], ["parent", meetup], ["child", community], ["child", meetup],
    ]);
    expect(parsed.parent).toBeUndefined();
    expect(parsed.children).toEqual([meetup]);
  });

  it("links only when both sides name each other", () => {
    expect(isLinked(community, { children: [meetup] }, meetup, { parent: community })).toBe(true);
    expect(isLinked(community, { children: [] }, meetup, { parent: community })).toBe(false);
    expect(isLinked(community, { children: [meetup] }, meetup, {})).toBe(false);
    expect(isLinked(meetup, { children: [meetup] }, meetup, { parent: meetup })).toBe(false);
  });

  it("verifies a proof from the child's E_id or current coordinator, and nothing else", () => {
    const authorities = membershipAuthorities(meetup, { coordinator: getPublicKey(coordSk) });
    const byEid = makeMembershipProof(eventSk, community, meetup, attendee);
    const byCoord = makeMembershipProof(coordSk, community, meetup, attendee);
    expect(verifyMembershipProof(byEid, community, meetup, attendee, authorities)).toBe(true);
    expect(verifyMembershipProof(byCoord, community, meetup, attendee, authorities)).toBe(true);
    // A replaced coordinator's proof stops working once the child names another.
    expect(verifyMembershipProof(byCoord, community, meetup, attendee, membershipAuthorities(meetup, {}))).toBe(false);
    // Bound to the attendee, the child and the parent.
    expect(verifyMembershipProof(byEid, community, meetup, getPublicKey(generateSecretKey()), authorities)).toBe(false);
    const other = makeCoordinate(getPublicKey(eventSk), "meetup-13");
    expect(verifyMembershipProof(byEid, community, other, attendee, authorities)).toBe(false);
    // A stranger's signature, and junk, are rejected without throwing.
    const stranger = makeMembershipProof(generateSecretKey(), community, meetup, attendee);
    expect(verifyMembershipProof(stranger, community, meetup, attendee, authorities)).toBe(false);
    expect(verifyMembershipProof({ by: "zz", sig: "zz" }, community, meetup, attendee, authorities)).toBe(false);
  });

  it("gives a malformed child no authorities instead of throwing (SB-29)", () => {
    const coordinator = getPublicKey(coordSk);
    for (const bad of ["not-a-coordinate", "", "31923:XYZ:ev"]) {
      expect(membershipAuthorities(bad, { coordinator })).toEqual([]);
    }
  });

  it("carries the proof in a join request tag and a key grant", () => {
    const proof = makeMembershipProof(eventSk, community, meetup, attendee);
    const tags = [["a", community], memberOfTag(meetup, proof), ["member_of", "junk"]];
    expect(parseMemberOfTags(tags)).toEqual([{ child: meetup, by: proof.by, sig: proof.sig }]);
    const grant = keyGrantContentSchema.parse({
      v: 2, a: meetup, role: "attendee", eck: [{ id: 1, key: "A".repeat(43) + "=" }], granted_by: hex(4), parent: proof,
    });
    expect(grant.parent?.a).toBe(community);
    // Without the field the grant parses exactly as before.
    expect(keyGrantContentSchema.parse({ v: 2, a: meetup, role: "attendee", eck: [], granted_by: hex(4) }).parent).toBeUndefined();
  });
});

/**
 * Audit SB-09 — a community's 31600 `a` tag named `31923:<E_id>:<d>`, the calendar
 * alias of itself, because the builder only knew the default kind.
 */
describe("audit SB-09 — the 31600 `a` tag names the space's real kind", () => {
  const eid = hex(5);
  const aTag = (cfg: EventConfig) => buildEventConfig(cfg).tags.find((t) => t[0] === "a")?.[1];

  it("a community config names its 31612 coordinate, and an event's tags are unchanged", () => {
    const community = makeCoordinate(eid, "club", KIND_COMMUNITY);
    expect(aTag({ ...base(eid, "club"), spaceKind: KIND_COMMUNITY })).toBe(community);
    // Without spaceKind (every dated event) the tags are exactly what they were.
    expect(aTag(base(eid, "ev"))).toBe(`31923:${eid}:ev`);
    expect(buildEventConfig({ ...base(eid, "ev"), spaceKind: 31923 }).tags).toEqual(buildEventConfig(base(eid, "ev")).tags);
    expect(() => buildEventConfig({ ...base(eid, "ev"), spaceKind: 1 })).toThrow();
  });

  it("parse keeps the kind of a correctly stamped community, so a re-save round-trips", () => {
    const tags = buildEventConfig({ ...base(eid, "club"), spaceKind: KIND_COMMUNITY }).tags;
    const parsed = parseEventConfig(eid, tags);
    expect(parsed.spaceKind).toBe(KIND_COMMUNITY);
    expect(configCoordinate(parsed)).toBe(makeCoordinate(eid, "club", KIND_COMMUNITY));
    expect(buildEventConfig(parsed).tags).toEqual(tags);
    expect(parseEventConfig(eid, buildEventConfig(base(eid, "ev")).tags).spaceKind).toBeUndefined();
  });

  it("configForSpace repairs a community stamped 31923 before the fix, and leaves an event alone", () => {
    const legacy = parseEventConfig(eid, buildEventConfig(base(eid, "club")).tags); // the old, wrong `a`
    expect(legacy.spaceKind).toBeUndefined();
    const community = makeCoordinate(eid, "club", KIND_COMMUNITY);
    expect(aTag(configForSpace(legacy, community))).toBe(community);
    const event = makeCoordinate(eid, "ev");
    const fixed = configForSpace({ ...base(eid, "ev"), spaceKind: KIND_COMMUNITY }, event);
    expect("spaceKind" in fixed).toBe(false);
    expect(aTag(fixed)).toBe(event);
  });
});
