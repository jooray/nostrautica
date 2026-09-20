import { describe, it, expect } from "vitest";
import { moreRows } from "./more-rows.js";

const visitor = { naddr: "naddr1test", isMember: false, isOrganizer: false, loggedIn: false };
const names = (o: Parameters<typeof moreRows>[0]) => moreRows(o).map((r) => r.go.name);

describe("moreRows", () => {
  it("offers a signed-out visitor only the rows that lead out of the event", () => {
    expect(names(visitor)).toEqual(["home", "create", "settings"]);
  });

  it("adds Messages on sign-in and the event profile on membership", () => {
    expect(names({ ...visitor, loggedIn: true })).toEqual(["dm", "home", "create", "settings"]);
    expect(names({ ...visitor, loggedIn: true, isMember: true })).toEqual([
      "myProfile",
      "dm",
      "home",
      "create",
      "settings",
    ]);
  });

  it("gives an organizer Manage event, above the global rows", () => {
    expect(names({ naddr: "naddr1test", isMember: true, isOrganizer: true, loggedIn: true })).toEqual([
      "myProfile",
      "dm",
      "admin",
      "home",
      "create",
      "settings",
    ]);
  });

  it("carries the event's naddr on every event-scoped row", () => {
    const rows = moreRows({ naddr: "naddr1abc", isMember: true, isOrganizer: true, loggedIn: true });
    for (const r of rows) {
      if ("naddr" in r.go) expect(r.go.naddr).toBe("naddr1abc");
    }
  });

  it("keys uniquely by route name — both surfaces key the rendered list by it", () => {
    const rows = moreRows({ naddr: "naddr1abc", isMember: true, isOrganizer: true, loggedIn: true });
    expect(new Set(rows.map((r) => r.go.name)).size).toBe(rows.length);
  });

  it("counts a DM thread as Messages and the event settings page as Manage event", () => {
    // The rail lights a row from `here`, and both of these are reachable under a
    // route name that is not the row's own destination.
    const rows = moreRows({ naddr: "naddr1abc", isMember: true, isOrganizer: true, loggedIn: true });
    const here = (name: string) => rows.find((r) => r.go.name === name)?.here;
    expect(here("dm")).toContain("dmPeer");
    expect(here("admin")).toContain("eventSettings");
  });

  it("labels rows from the catalog rather than leaving raw keys on screen", () => {
    for (const r of moreRows({ ...visitor, loggedIn: true, isMember: true, isOrganizer: true })) {
      expect(r.label).not.toMatch(/^[a-z]+\./);
      expect(r.label.length).toBeGreaterThan(0);
    }
  });
});
