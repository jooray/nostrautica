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
