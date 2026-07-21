import { describe, it, expect } from "vitest";
import { parseHash, buildHash, eventNaddr, routeTitleKey, type Route } from "./routes.js";
import { messages } from "$lib/i18n/messages.js";

describe("parseHash", () => {
  const cases: [string, Route][] = [
    ["", { name: "home" }],
    ["#/", { name: "home" }],
    ["#/create", { name: "create" }],
    ["#/me", { name: "me" }],
    ["#/settings", { name: "settings" }],
    ["#/login", { name: "login" }],
    ["#/login?nsec=nsec1abc", { name: "login", nsec: "nsec1abc" }],
    ["#/e/naddr1xyz", { name: "event", naddr: "naddr1xyz" }],
    ["#/e/naddr1xyz/join", { name: "join", naddr: "naddr1xyz" }],
    ["#/e/naddr1xyz/join?code=nsec1code", { name: "join", naddr: "naddr1xyz", code: "nsec1code" }],
    ["#/e/naddr1xyz/record", { name: "record", naddr: "naddr1xyz", talk: false }],
    ["#/e/naddr1xyz/record?talk=1", { name: "record", naddr: "naddr1xyz", talk: true }],
    ["#/e/naddr1xyz/attendees", { name: "attendees", naddr: "naddr1xyz" }],
    ["#/e/naddr1xyz/attendees/npub1abc", { name: "attendee", naddr: "naddr1xyz", npub: "npub1abc" }],
    ["#/e/naddr1xyz/matches", { name: "matches", naddr: "naddr1xyz" }],
    ["#/e/naddr1xyz/chat", { name: "chat", naddr: "naddr1xyz" }],
    ["#/e/naddr1xyz/talks", { name: "talks", naddr: "naddr1xyz" }],
    ["#/e/naddr1xyz/talks/tk1", { name: "talk", naddr: "naddr1xyz", d: "tk1" }],
    ["#/e/naddr1xyz/admin", { name: "admin", naddr: "naddr1xyz" }],
    ["#/e/naddr1xyz/settings", { name: "eventSettings", naddr: "naddr1xyz" }],
    ["#/e/naddr1xyz/posts", { name: "posts", naddr: "naddr1xyz" }],
    ["#/e/naddr1xyz/posts/abc123", { name: "post", naddr: "naddr1xyz", d: "abc123" }],
    ["#/e/naddr1xyz/more", { name: "eventMore", naddr: "naddr1xyz" }],
  ];

  it.each(cases)("parses %s", (hash, expected) => {
    expect(parseHash(hash)).toEqual(expected);
  });

  it("returns notFound for unknown paths", () => {
    expect(parseHash("#/nonsense").name).toBe("notFound");
    expect(parseHash("#/e/naddr1/bogus").name).toBe("notFound");
    expect(parseHash("#/e").name).toBe("notFound");
  });
});

describe("buildHash", () => {
  it("is the inverse of parseHash for known routes", () => {
    const routes: Route[] = [
      { name: "home" },
      { name: "create" },
      { name: "login", nsec: "nsec1abc" },
      { name: "event", naddr: "naddr1xyz" },
      { name: "join", naddr: "naddr1xyz", code: "nsec1code" },
      { name: "record", naddr: "naddr1xyz", talk: true },
      { name: "attendee", naddr: "naddr1xyz", npub: "npub1abc" },
      { name: "matches", naddr: "naddr1xyz" },
      { name: "talks", naddr: "naddr1xyz" },
      { name: "talk", naddr: "naddr1xyz", d: "tk1" },
      { name: "admin", naddr: "naddr1xyz" },
      { name: "eventSettings", naddr: "naddr1xyz" },
      { name: "posts", naddr: "naddr1xyz" },
      { name: "post", naddr: "naddr1xyz", d: "abc123" },
      { name: "eventMore", naddr: "naddr1xyz" },
      { name: "dm" },
      { name: "dmPeer", npub: "npub1abc" },
    ];
    for (const r of routes) {
      expect(parseHash(buildHash(r))).toEqual(r);
    }
  });
});

describe("eventNaddr — which routes an event theme may be active on", () => {
  it("returns the naddr for every event-scoped route", () => {
    const eventRoutes: Route[] = [
      { name: "event", naddr: "naddr1xyz" },
      { name: "join", naddr: "naddr1xyz" },
      { name: "record", naddr: "naddr1xyz", talk: false },
      { name: "attendees", naddr: "naddr1xyz" },
      { name: "attendee", naddr: "naddr1xyz", npub: "npub1abc" },
      { name: "matches", naddr: "naddr1xyz" },
      { name: "talks", naddr: "naddr1xyz" },
      { name: "talk", naddr: "naddr1xyz", d: "tk1" },
      { name: "admin", naddr: "naddr1xyz" },
      { name: "eventSettings", naddr: "naddr1xyz" },
      { name: "posts", naddr: "naddr1xyz" },
      { name: "post", naddr: "naddr1xyz", d: "abc" },
      { name: "eventMore", naddr: "naddr1xyz" },
    ];
    for (const r of eventRoutes) expect(eventNaddr(r)).toBe("naddr1xyz");
  });

  it("returns undefined on login/settings/DM/home routes (never themed)", () => {
    const bare: Route[] = [
      { name: "home" },
      { name: "login" },
      { name: "settings" },
      { name: "me" },
      { name: "create" },
      { name: "dm" },
      { name: "dmPeer", npub: "npub1abc" },
      { name: "notFound", hash: "#/x" },
    ];
    for (const r of bare) expect(eventNaddr(r)).toBeUndefined();
  });
});

describe("routeTitleKey (A2)", () => {
  const routes: Route[] = [
    { name: "home" },
    { name: "login" },
    { name: "create" },
    { name: "me" },
    { name: "settings" },
    { name: "event", naddr: "n" },
    { name: "join", naddr: "n" },
    { name: "record", naddr: "n", talk: false },
    { name: "attendees", naddr: "n" },
    { name: "attendee", naddr: "n", npub: "p" },
    { name: "matches", naddr: "n" },
    { name: "talks", naddr: "n" },
    { name: "talk", naddr: "n", d: "d" },
    { name: "admin", naddr: "n" },
    { name: "eventSettings", naddr: "n" },
    { name: "posts", naddr: "n" },
    { name: "post", naddr: "n", d: "d" },
    { name: "dm" },
    { name: "dmPeer", npub: "p" },
    { name: "notFound", hash: "#/x" },
  ];

  it("every route maps to a title key defined in BOTH locales", () => {
    for (const r of routes) {
      const key = routeTitleKey(r);
      expect(key).toBe(`title.${r.name}`);
      expect(messages.en, `${key} missing in en`).toHaveProperty(key);
      expect(messages.sk, `${key} missing in sk`).toHaveProperty(key);
    }
  });
});
