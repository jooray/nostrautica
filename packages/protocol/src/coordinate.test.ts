import { describe, it, expect } from "vitest";
import {
  makeCoordinate,
  parseCoordinate,
  coordinateToNaddr,
  naddrToCoordinate,
} from "./coordinate.js";
import { buildEventConfig, parseEventConfig } from "./config.js";

const pubkey = "a".repeat(64);

describe("coordinates", () => {
  it("builds and parses", () => {
    const coord = makeCoordinate(pubkey, "my-event");
    expect(coord).toBe("31923:" + pubkey + ":my-event");
    const parsed = parseCoordinate(coord);
    expect(parsed).toEqual({ kind: 31923, pubkey, identifier: "my-event" });
  });

  it("handles identifiers containing colons", () => {
    const coord = makeCoordinate(pubkey, "a:b:c");
    expect(parseCoordinate(coord).identifier).toBe("a:b:c");
  });

  it("round-trips through naddr", () => {
    const coord = makeCoordinate(pubkey, "ev");
    const naddr = coordinateToNaddr(coord, ["wss://relay.example"]);
    const back = naddrToCoordinate(naddr);
    expect(back.coordinate).toBe(coord);
    expect(back.relays).toEqual(["wss://relay.example"]);
  });
});

describe("event config (kind 31600)", () => {
  it("builds tags and parses them back", () => {
    const cfg = {
      d: "ev",
      eidPubkey: pubkey,
      inbox: "b".repeat(64),
      coordinator: "c".repeat(64),
      relays: ["wss://relay.a", "wss://relay.b"],
      blossom: ["https://blossom.a"],
      maxVideoSec: 90,
      maxTalkSec: 900,
      matching: "on" as const,
      matchVisibility: "pair" as const,
      approval: "manual+invite" as const,
      eck: 1,
      nostrContext: 100,
      lang: "sk" as const,
    };
    const built = buildEventConfig(cfg);
    expect(built.kind).toBe(31600);
    expect(built.tags).toContainEqual(["lang", "sk"]);
    const parsed = parseEventConfig(pubkey, built.tags);
    expect(parsed).toEqual(cfg);
  });

  it("omits the lang tag for the default (en) but parses it back", () => {
    const cfg = {
      d: "ev",
      eidPubkey: pubkey,
      inbox: "b".repeat(64),
      relays: [],
      blossom: [],
      maxVideoSec: 90,
      maxTalkSec: 900,
      matching: "off" as const,
      matchVisibility: "pair" as const,
      approval: "manual" as const,
      eck: 1,
      nostrContext: 0,
      lang: "en",
    };
    const built = buildEventConfig(cfg);
    expect(built.tags.find((t) => t[0] === "lang")).toBeUndefined();
    expect(parseEventConfig(pubkey, built.tags).lang).toBe("en");
  });

  it("defaults sensibly when tags are missing", () => {
    const parsed = parseEventConfig(pubkey, [
      ["d", "ev"],
      ["inbox", "b".repeat(64)],
    ]);
    expect(parsed.approval).toBe("manual");
    expect(parsed.matching).toBe("off");
    expect(parsed.matchVisibility).toBe("pair");
    expect(parsed.nostrContext).toBe(0);
    expect(parsed.coordinator).toBeUndefined();
  });

  // ── Q7: malformed config degrades to defaults, never NaN / bad enums ────────
  it("clamps out-of-range enums to their documented defaults", () => {
    const parsed = parseEventConfig(pubkey, [
      ["d", "ev"],
      ["inbox", "b".repeat(64)],
      ["approval", "everyone"], // not a valid Approval
      ["match_visibility", "world"], // not a valid MatchVisibility
    ]);
    expect(parsed.approval).toBe("manual");
    expect(parsed.matchVisibility).toBe("pair");
  });

  it("falls back to defaults for non-numeric / negative numeric tags (never NaN)", () => {
    const parsed = parseEventConfig(pubkey, [
      ["d", "ev"],
      ["inbox", "b".repeat(64)],
      ["max_video_sec", "not-a-number"],
      ["nostr_context", "-5"],
      ["eck", "0"],
    ]);
    expect(parsed.maxVideoSec).toBe(90);
    expect(Number.isNaN(parsed.maxVideoSec)).toBe(false);
    expect(parsed.nostrContext).toBe(0);
    expect(parsed.eck).toBe(1); // clamped to a valid ≥1 version
  });
});
