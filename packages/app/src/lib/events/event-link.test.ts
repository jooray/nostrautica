import { describe, it, expect } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { coordinateToNaddr, KIND_CALENDAR_EVENT, KIND_COMMUNITY } from "@nostrautica/protocol";
import { parseEventLink } from "./event-link.js";

/**
 * The paste box on Home is the PWA's only way in from a link, so the list of
 * shapes it accepts is a promise, not an implementation detail: an organizer who
 * sends an invite has no idea which of these the invitee will end up holding
 * after it has been through a chat app, a QR scanner and a paste.
 */

const E_ID = "a".repeat(64);
const OTHER = "b".repeat(64);
const EVENT_COORD = `${KIND_CALENDAR_EVENT}:${E_ID}:devconf-2f9c1a`;
const COMMUNITY_COORD = `${KIND_COMMUNITY}:${E_ID}:cypherpunk`;
const eventNaddr = coordinateToNaddr(EVENT_COORD);
const communityNaddr = coordinateToNaddr(COMMUNITY_COORD);
const APP = "https://nostrautica.cypherpunk.today/app/";

describe("parseEventLink: links this app hands out", () => {
  it("keeps the invite code off a join link — the whole point of pasting one", () => {
    const nsec = "nsec1" + "q".repeat(58);
    const r = parseEventLink(`${APP}#/e/${eventNaddr}/join?code=${nsec}&lang=sk`);
    expect(r).toMatchObject({
      ok: true,
      coordinate: EVENT_COORD,
      route: { name: "join", naddr: eventNaddr, code: nsec },
    });
  });

  it("reads a plain shared event link", () => {
    expect(parseEventLink(`${APP}#/e/${eventNaddr}`)).toMatchObject({
      ok: true,
      route: { name: "event", naddr: eventNaddr },
    });
  });

  it("reads a standing community exactly like a dated event", () => {
    expect(parseEventLink(`${APP}#/e/${communityNaddr}`)).toMatchObject({
      ok: true,
      coordinate: COMMUNITY_COORD,
      route: { name: "event", naddr: communityNaddr },
    });
  });

  it("lands on the screen a deep link names, not just the event home", () => {
    expect(parseEventLink(`${APP}#/e/${eventNaddr}/talks/keynote`)).toMatchObject({
      ok: true,
      route: { name: "talk", naddr: eventNaddr, d: "keynote" },
    });
  });

  it("accepts a bare hash, which is what a copied in-app URL bar can end up as", () => {
    expect(parseEventLink(`#/e/${eventNaddr}/attendees`)).toMatchObject({
      ok: true,
      route: { name: "attendees", naddr: eventNaddr },
    });
  });
});

describe("parseEventLink: whatever a link survives being copied as", () => {
  it("accepts a bare naddr", () => {
    expect(parseEventLink(eventNaddr)).toMatchObject({
      ok: true,
      route: { name: "event", naddr: eventNaddr },
    });
  });

  it("accepts the nostr: scheme", () => {
    expect(parseEventLink(`nostr:${eventNaddr}`)).toMatchObject({ ok: true, naddr: eventNaddr });
  });

  it("finds the address inside a sentence and drops the punctuation around it", () => {
    const r = parseEventLink(`join us! <${APP}#/e/${eventNaddr}>.`);
    expect(r).toMatchObject({ ok: true, naddr: eventNaddr });
  });

  it("finds the address in a third-party viewer's link", () => {
    expect(parseEventLink(`https://njump.me/${eventNaddr}`)).toMatchObject({
      ok: true,
      naddr: eventNaddr,
    });
  });

  it("accepts an upper-cased address (bech32 is case-insensitive, decoders aren't)", () => {
    expect(parseEventLink(eventNaddr.toUpperCase())).toMatchObject({
      ok: true,
      naddr: eventNaddr,
      coordinate: EVENT_COORD,
    });
  });

  it("accepts a raw coordinate", () => {
    expect(parseEventLink(EVENT_COORD)).toMatchObject({
      ok: true,
      coordinate: EVENT_COORD,
      route: { name: "event", naddr: eventNaddr },
    });
  });

  it("ignores surrounding whitespace from a sloppy selection", () => {
    expect(parseEventLink(`  \n${eventNaddr}\n  `)).toMatchObject({ ok: true, naddr: eventNaddr });
  });
});

describe("parseEventLink: what it refuses, and how it says so", () => {
  it("says nothing about an empty box", () => {
    expect(parseEventLink("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("tells a real Nostr address that isn't an event apart from noise", () => {
    expect(parseEventLink(npubEncode(OTHER))).toEqual({ ok: false, reason: "notAnEvent" });
  });

  it("refuses an naddr for some other addressable kind", () => {
    // A long-form post is a perfectly good naddr. Opening it as an event would
    // put a card on Home that can never load (audit R18 is the same guard on
    // the wire side: a bounded allowlist of the two space kinds, nothing wider).
    expect(parseEventLink(coordinateToNaddr(`30023:${OTHER}:my-article`))).toEqual({
      ok: false,
      reason: "notAnEvent",
    });
  });

  it("refuses a coordinate for some other kind", () => {
    expect(parseEventLink(`30023:${OTHER}:my-article`)).toEqual({
      ok: false,
      reason: "notAnEvent",
    });
  });

  it("calls a link with no address in it unrecognized, not 'not an event'", () => {
    expect(parseEventLink(APP)).toEqual({ ok: false, reason: "unrecognized" });
    expect(parseEventLink(`${APP}#/settings`)).toEqual({ ok: false, reason: "unrecognized" });
    expect(parseEventLink("hello")).toEqual({ ok: false, reason: "unrecognized" });
  });

  it("refuses a truncated address rather than navigating to a broken card", () => {
    expect(parseEventLink(`${APP}#/e/${eventNaddr.slice(0, 20)}`)).toEqual({
      ok: false,
      reason: "unrecognized",
    });
  });
});

/**
 * A link that did NOT arrive intact.
 *
 * Every case here used to resolve to the right EVENT with the invite code gone —
 * no error, nothing on screen to notice, and a join that goes to the approval
 * queue the code existed to skip. Traced from a real join on 2026-09-17: the
 * coordinator logged `invite=no → manual queue (no invite proof)` while the
 * shared door code that join should have carried was live, unexpired and 99 of
 * its 100 uses unspent.
 */
describe("parseEventLink: links something en route has mangled", () => {
  const nsec = "nsec1" + "q".repeat(58);
  const invite = `${APP}#/e/${eventNaddr}/join?code=${nsec}&lang=sk`;
  const joined = { name: "join", naddr: eventNaddr, code: nsec };

  it("keeps the code when the whole URL was percent-encoded", () => {
    expect(parseEventLink(encodeURIComponent(invite))).toMatchObject({
      ok: true,
      route: joined,
    });
  });

  it("keeps the code when only the fragment marker was escaped", () => {
    expect(parseEventLink(invite.replace("#", "%23"))).toMatchObject({
      ok: true,
      route: joined,
    });
  });

  it("keeps the code through a click-tracking gateway's ?url= parameter", () => {
    const wrapped = `https://gate.example/click?url=${encodeURIComponent(invite)}&id=7`;
    expect(parseEventLink(wrapped)).toMatchObject({ ok: true, route: joined });
  });

  it("keeps the code when a client upper-cased the link", () => {
    // Bech32 is case-insensitive; lowercase is the canonical spelling, and both
    // the address and the code come back in it.
    expect(parseEventLink(invite.toUpperCase())).toMatchObject({
      ok: true,
      route: joined,
    });
  });

  it("re-attaches a code to an address only the bare-entity scan could recover", () => {
    // The route is unreadable (no hash at all), but the code is right there.
    expect(parseEventLink(`nostr:${eventNaddr} ?code=${nsec}`)).toMatchObject({
      ok: true,
      route: joined,
    });
  });

  it("re-attaches a code to a raw coordinate too", () => {
    expect(parseEventLink(`${EVENT_COORD} #code=${nsec}`)).toMatchObject({
      ok: true,
      route: { name: "join", naddr: eventNaddr, code: nsec },
    });
  });

  it("never reads a bare nsec in pasted text as an invite code", () => {
    // An nsec on its own is overwhelmingly likely to be somebody's ACCOUNT key.
    // toEqual on the route, not toMatchObject: a leaked `code` must FAIL here.
    const r = parseEventLink(`${eventNaddr} my key is ${nsec}`);
    expect(r.ok).toBe(true);
    expect(r.ok && r.route).toEqual({ name: "event", naddr: eventNaddr });
  });

  it("leaves an intact link's own parse untouched", () => {
    // The original spelling is always tried first, so nothing above can change
    // the meaning of a link that arrived whole — including a case-sensitive `d`.
    const r = parseEventLink(`${APP}#/e/${eventNaddr}/talks/My-Talk-01`);
    expect(r.ok).toBe(true);
    expect(r.ok && r.route).toEqual({ name: "talk", naddr: eventNaddr, d: "My-Talk-01" });
  });

  it("still refuses text that carries a code but no address", () => {
    expect(parseEventLink(`${APP}#/join?code=${nsec}`)).toEqual({
      ok: false,
      reason: "unrecognized",
    });
  });
});
