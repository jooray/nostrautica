import { describe, it, expect } from "vitest";
import { parseHash, buildHash, type Route } from "./routes.js";

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
    ["#/e/naddr1xyz/admin", { name: "admin", naddr: "naddr1xyz" }],
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
      { name: "dm" },
      { name: "dmPeer", npub: "npub1abc" },
    ];
    for (const r of routes) {
      expect(parseHash(buildHash(r))).toEqual(r);
    }
  });
});
