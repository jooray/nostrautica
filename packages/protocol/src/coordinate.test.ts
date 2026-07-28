import { describe, it, expect } from "vitest";
import {
  makeCoordinate,
  parseCoordinate,
  parseEventCoordinate,
  isEventCoordinate,
  coordinateToNaddr,
  naddrToCoordinate,
} from "./coordinate.js";
import { buildEventConfig, parseEventConfig, isMarmotChatEnabled, UNLIMITED_SEC } from "./config.js";

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

  it("rejects a non-hex or wrong-case pubkey (PROTO-5)", () => {
    expect(() => parseCoordinate("31923:" + "z".repeat(64) + ":ev")).toThrow();
    expect(() => parseCoordinate("31923:" + "A".repeat(64) + ":ev")).toThrow();
    expect(() => parseCoordinate("31923:" + "a".repeat(63) + ":ev")).toThrow();
    expect(() => parseCoordinate("31923:" + "a".repeat(65) + ":ev")).toThrow();
  });

  // ── R18: event-coordinate (kind exactly 31923) validation ──────────────────
  it("parseEventCoordinate accepts only kind 31923, rejects alias kinds", () => {
    const coord = makeCoordinate(pubkey, "ev");
    expect(parseEventCoordinate(coord)).toEqual({ kind: 31923, pubkey, identifier: "ev" });
    // An alias kind against the SAME author/identifier (the R18 divergent-namespace
    // vector) is rejected.
    expect(() => parseEventCoordinate("1:" + pubkey + ":ev")).toThrow(/31923/);
    expect(() => parseEventCoordinate("31600:" + pubkey + ":ev")).toThrow(/31923/);
    // Structurally malformed coordinates still throw.
    expect(() => parseEventCoordinate("garbage")).toThrow();
    expect(() => parseEventCoordinate("31923:" + "z".repeat(64) + ":ev")).toThrow();
  });

  it("isEventCoordinate is true only for a canonical 31923 coordinate", () => {
    expect(isEventCoordinate(makeCoordinate(pubkey, "ev"))).toBe(true);
    expect(isEventCoordinate("1:" + pubkey + ":ev")).toBe(false);
    expect(isEventCoordinate("31923:" + "A".repeat(64) + ":ev")).toBe(false); // bad-case pubkey
    expect(isEventCoordinate("not-a-coordinate")).toBe(false);
  });

  it("rejects kinds outside the NIP-01 16-bit range (PROTO-5)", () => {
    expect(() => parseCoordinate("-1:" + pubkey + ":ev")).toThrow();
    expect(() => parseCoordinate("65536:" + pubkey + ":ev")).toThrow();
    expect(() => parseCoordinate("3.5:" + pubkey + ":ev")).toThrow();
    expect(() => parseCoordinate("abc:" + pubkey + ":ev")).toThrow();
    expect(parseCoordinate("0:" + pubkey + ":ev").kind).toBe(0);
    expect(parseCoordinate("65535:" + pubkey + ":ev").kind).toBe(65535);
  });
});

describe("event config (kind 31600)", () => {
  it("builds tags and parses them back", () => {
    const cfg = {
      d: "ev",
      eidPubkey: pubkey,
      inbox: "b".repeat(64),
      coordinator: "c".repeat(64),
      coordinatorGen: 3,
      relays: ["wss://relay.a", "wss://relay.b"],
      chatRelays: ["wss://chat.a"],
      blossom: ["https://blossom.a"],
      maxVideoSec: 90,
      maxTalkSec: 900,
      matching: "on" as const,
      matchVisibility: "pair" as const,
      approval: "manual+invite" as const,
      eck: 1,
      nostrContext: 100,
      lang: "sk" as const,
      talks: "prerecord-first" as const,
      chat: ["marmot" as const],
    };
    const built = buildEventConfig(cfg);
    expect(built.kind).toBe(31600);
    expect(built.tags).toContainEqual(["lang", "sk"]);
    expect(built.tags).toContainEqual(["talks", "prerecord-first"]);
    expect(built.tags).toContainEqual(["chat", "marmot"]);
    expect(built.tags).toContainEqual(["chat_relay", "wss://chat.a"]);
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
      talks: "off" as const,
      chat: [],
    };
    const built = buildEventConfig(cfg);
    expect(built.tags.find((t) => t[0] === "lang")).toBeUndefined();
    expect(parseEventConfig(pubkey, built.tags).lang).toBe("en");
  });

  it("omits the talks tag when off (default) but round-trips on/prerecord-first", () => {
    const base = {
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
      chat: [] as ("marmot")[],
    };
    // off → tag omitted, parses back to "off"
    const offBuilt = buildEventConfig({ ...base, talks: "off" });
    expect(offBuilt.tags.find((t) => t[0] === "talks")).toBeUndefined();
    expect(parseEventConfig(pubkey, offBuilt.tags).talks).toBe("off");
    // a config with NO talks tag at all parses as "off" (normal event unchanged)
    expect(parseEventConfig(pubkey, [["d", "ev"], ["v", "2"], ["inbox", "b".repeat(64)]]).talks).toBe("off");
    // on → emitted + parsed
    const onBuilt = buildEventConfig({ ...base, talks: "on" });
    expect(onBuilt.tags).toContainEqual(["talks", "on"]);
    expect(parseEventConfig(pubkey, onBuilt.tags).talks).toBe("on");
    // an unrecognized talks value degrades to "off" (never throws)
    expect(parseEventConfig(pubkey, [["d", "ev"], ["v", "2"], ["inbox", "b".repeat(64)], ["talks", "bogus"]]).talks).toBe("off");
  });

  it("omits the retention tag by default but round-trips a positive day count (NIP §6.2)", () => {
    const base = {
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
      talks: "off" as const,
      chat: [] as ("marmot")[],
    };
    // Absent → no tag, parses back to undefined (indefinite retention).
    const noRet = buildEventConfig(base);
    expect(noRet.tags.find((t) => t[0] === "retention")).toBeUndefined();
    expect(parseEventConfig(pubkey, noRet.tags).retentionDays).toBeUndefined();
    // Present → emitted + parsed.
    const built = buildEventConfig({ ...base, retentionDays: 90 });
    expect(built.tags).toContainEqual(["retention", "90"]);
    expect(parseEventConfig(pubkey, built.tags).retentionDays).toBe(90);
    // A non-positive/non-integer retention tag from a relay degrades to undefined.
    expect(parseEventConfig(pubkey, [["d", "ev"], ["v", "2"], ["inbox", "b".repeat(64)], ["retention", "0"]]).retentionDays).toBeUndefined();
    expect(parseEventConfig(pubkey, [["d", "ev"], ["v", "2"], ["inbox", "b".repeat(64)], ["retention", "1.5"]]).retentionDays).toBeUndefined();
    // Build rejects an invalid value (programming error at the boundary).
    expect(() => buildEventConfig({ ...base, retentionDays: 0 })).toThrow();
    // Set → clear → tag absent (item 6): the organizer settings UI clears the
    // window by republishing the config with retentionDays === undefined
    // (updateEventConfig spreads `{ ...cfg, retentionDays: undefined }`). The
    // built config must then carry NO retention tag and parse back to undefined,
    // exactly as if it had never been set.
    const withRet = parseEventConfig(pubkey, built.tags);
    const cleared = buildEventConfig({ ...withRet, retentionDays: undefined });
    expect(cleared.tags.find((t) => t[0] === "retention")).toBeUndefined();
    expect(parseEventConfig(pubkey, cleared.tags).retentionDays).toBeUndefined();
  });

  it("omits the chat tag when off (default) but round-trips marmot", () => {
    const base = {
      d: "ev",
      eidPubkey: pubkey,
      inbox: "b".repeat(64),
      coordinator: "c".repeat(64),
      coordinatorGen: 1,
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
      talks: "off" as const,
    };
    // chat off → tag omitted, parses back to []
    const offBuilt = buildEventConfig({ ...base, chat: [] });
    expect(offBuilt.tags.find((t) => t[0] === "chat")).toBeUndefined();
    expect(parseEventConfig(pubkey, offBuilt.tags).chat).toEqual([]);
    // a config with NO chat tag parses as [] (normal event unchanged)
    expect(parseEventConfig(pubkey, [["d", "ev"], ["v", "2"], ["inbox", "b".repeat(64)]]).chat).toEqual([]);
    // marmot → emitted + parsed
    const onBuilt = buildEventConfig({ ...base, chat: ["marmot"] });
    expect(onBuilt.tags).toContainEqual(["chat", "marmot"]);
    expect(parseEventConfig(pubkey, onBuilt.tags).chat).toEqual(["marmot"]);
  });

  // Chat relays (`chat_relay`) — the Marmot interop set, deliberately NOT part of
  // the event's general `relay` list: those relays accept only the chat kinds and
  // reject everything else this protocol publishes.
  describe("chat relays", () => {
    const base = {
      d: "ev",
      eidPubkey: pubkey,
      inbox: "b".repeat(64),
      relays: ["wss://relay.a"],
      blossom: [],
      maxVideoSec: 90,
      maxTalkSec: 900,
      matching: "off" as const,
      matchVisibility: "pair" as const,
      approval: "manual" as const,
      eck: 1,
      nostrContext: 0,
      lang: "en",
      talks: "off" as const,
      chat: [] as ("marmot")[],
    };

    it("emits no tag at all when there are none (chat-off event stays byte-identical)", () => {
      const withField = buildEventConfig({ ...base, chatRelays: [] });
      // The exact tag array a pre-`chat_relay` build produced for the same config.
      const legacyShape = buildEventConfig({ ...base } as Parameters<typeof buildEventConfig>[0]);
      expect(withField.tags).toEqual(legacyShape.tags);
      expect(withField.tags.some((t) => t[0] === "chat_relay")).toBe(false);
      expect(parseEventConfig(pubkey, withField.tags).chatRelays).toEqual([]);
    });

    it("round-trips a chat relay set separately from the event relays", () => {
      const built = buildEventConfig({
        ...base,
        chat: ["marmot"],
        relays: ["wss://relay.a", "wss://relay.b"],
        chatRelays: ["wss://chat.a", "wss://chat.b"],
      });
      expect(built.tags.filter((t) => t[0] === "relay")).toEqual([
        ["relay", "wss://relay.a"],
        ["relay", "wss://relay.b"],
      ]);
      const parsed = parseEventConfig(pubkey, built.tags);
      expect(parsed.relays).toEqual(["wss://relay.a", "wss://relay.b"]);
      expect(parsed.chatRelays).toEqual(["wss://chat.a", "wss://chat.b"]);
    });

    it("drops a non-wss chat_relay the same way it drops a bad relay (PROTO-5)", () => {
      const parsed = parseEventConfig(pubkey, [
        ["d", "ev"], ["v", "2"],
        ["inbox", "b".repeat(64)],
        ["chat_relay", "https://not-a-relay.example"],
        ["chat_relay", "not a url"],
        ["chat_relay", "wss://chat.a"],
      ]);
      expect(parsed.chatRelays).toEqual(["wss://chat.a"]);
    });

    // BACKWARD COMPAT — configs published before `chat_relay` existed carry the
    // interop relays inside their `relay` tags, which is precisely what made every
    // 31600/31603/kind-5 publish fail against two of the event's own relays. The
    // parser MOVES them (never drops them) so an already-running chat group keeps
    // reaching Whitenoise clients while the rest of the app stops publishing there.
    it("migrates the legacy interop relays out of `relay` and into chatRelays", () => {
      const parsed = parseEventConfig(pubkey, [
        ["d", "ev"], ["v", "2"],
        ["inbox", "b".repeat(64)],
        ["relay", "wss://relay.a"],
        ["relay", "wss://relay.us.whitenoise.chat"],
        ["relay", "wss://relay.eu.whitenoise.chat/"], // trailing slash, same host
        ["relay", "wss://relay.b"],
        ["chat", "marmot"],
      ]);
      expect(parsed.relays).toEqual(["wss://relay.a", "wss://relay.b"]);
      expect(parsed.chatRelays).toEqual([
        "wss://relay.us.whitenoise.chat",
        "wss://relay.eu.whitenoise.chat/",
      ]);
    });

    it("migrates even when chat is off (those relays are useless for anything else)", () => {
      const parsed = parseEventConfig(pubkey, [
        ["d", "ev"], ["v", "2"],
        ["inbox", "b".repeat(64)],
        ["relay", "wss://relay.us.whitenoise.chat"],
        ["relay", "wss://relay.a"],
      ]);
      expect(parsed.chat).toEqual([]);
      expect(parsed.relays).toEqual(["wss://relay.a"]);
      expect(parsed.chatRelays).toEqual(["wss://relay.us.whitenoise.chat"]);
    });

    it("is idempotent: re-parsing a migrated config that names the pair in both places", () => {
      const parsed = parseEventConfig(pubkey, [
        ["d", "ev"], ["v", "2"],
        ["inbox", "b".repeat(64)],
        ["relay", "wss://relay.a"],
        ["relay", "wss://relay.us.whitenoise.chat"],
        ["chat_relay", "wss://relay.us.whitenoise.chat"],
        ["chat_relay", "wss://relay.eu.whitenoise.chat"],
      ]);
      expect(parsed.relays).toEqual(["wss://relay.a"]);
      expect(parsed.chatRelays).toEqual([
        "wss://relay.us.whitenoise.chat",
        "wss://relay.eu.whitenoise.chat",
      ]);
      // …and a rebuild of the parsed result parses back to itself.
      expect(parseEventConfig(pubkey, buildEventConfig(parsed).tags)).toEqual(parsed);
    });

    it("keeps a non-interop relay in `relays` even when chat relays are present", () => {
      const parsed = parseEventConfig(pubkey, [
        ["d", "ev"], ["v", "2"],
        ["inbox", "b".repeat(64)],
        ["relay", "wss://relay.a"],
        ["chat_relay", "wss://chat.a"],
      ]);
      expect(parsed.relays).toEqual(["wss://relay.a"]);
      expect(parsed.chatRelays).toEqual(["wss://chat.a"]);
    });
  });

  it("drops unknown chat values and de-duplicates known ones", () => {
    // unknown backend → dropped (never surfaced), keeps the known one once
    const parsed = parseEventConfig(pubkey, [
      ["d", "ev"], ["v", "2"],
      ["inbox", "b".repeat(64)],
      ["chat", "signal"], // unknown backend
      ["chat", "marmot"],
      ["chat", "marmot"], // duplicate
    ]);
    expect(parsed.chat).toEqual(["marmot"]);
  });

  it("isMarmotChatEnabled requires both the chat tag and a coordinator", () => {
    const withCoord = parseEventConfig(pubkey, [
      ["d", "ev"], ["v", "2"],
      ["inbox", "b".repeat(64)],
      ["coordinator", "c".repeat(64), "1"],
      ["chat", "marmot"],
    ]);
    expect(isMarmotChatEnabled(withCoord)).toBe(true);
    // chat=marmot but no coordinator → parsed (kept) but NOT operative
    const noCoord = parseEventConfig(pubkey, [
      ["d", "ev"], ["v", "2"],
      ["inbox", "b".repeat(64)],
      ["chat", "marmot"],
    ]);
    expect(noCoord.chat).toEqual(["marmot"]);
    expect(isMarmotChatEnabled(noCoord)).toBe(false);
    // coordinator but no chat → not operative
    const noChat = parseEventConfig(pubkey, [
      ["d", "ev"], ["v", "2"],
      ["inbox", "b".repeat(64)],
      ["coordinator", "c".repeat(64), "1"],
    ]);
    expect(isMarmotChatEnabled(noChat)).toBe(false);
  });

  it("defaults sensibly when tags are missing", () => {
    const parsed = parseEventConfig(pubkey, [
      ["d", "ev"], ["v", "2"],
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
      ["d", "ev"], ["v", "2"],
      ["inbox", "b".repeat(64)],
      ["approval", "everyone"], // not a valid Approval
      ["match_visibility", "world"], // not a valid MatchVisibility
    ]);
    expect(parsed.approval).toBe("manual");
    expect(parsed.matchVisibility).toBe("pair");
  });

  it("round-trips 0 (UNLIMITED_SEC) for max_video_sec / max_talk_sec distinctly from an absent tag", () => {
    const base = {
      d: "ev",
      eidPubkey: pubkey,
      inbox: "b".repeat(64),
      relays: [],
      blossom: [],
      matching: "off" as const,
      matchVisibility: "pair" as const,
      approval: "manual" as const,
      eck: 1,
      nostrContext: 0,
      lang: "en",
      talks: "off" as const,
      chat: [] as ("marmot")[],
    };
    // Explicit 0 → tag emitted as "0" → parses back to 0 (unlimited), not the default.
    const unlimited = buildEventConfig({ ...base, maxVideoSec: UNLIMITED_SEC, maxTalkSec: UNLIMITED_SEC });
    expect(unlimited.tags).toContainEqual(["max_video_sec", "0"]);
    expect(unlimited.tags).toContainEqual(["max_talk_sec", "0"]);
    const parsedUnlimited = parseEventConfig(pubkey, unlimited.tags);
    expect(parsedUnlimited.maxVideoSec).toBe(UNLIMITED_SEC);
    expect(parsedUnlimited.maxTalkSec).toBe(UNLIMITED_SEC);
    // An event with the tag entirely absent (legacy/backward-compat) still falls
    // back to the spec defaults, NOT unlimited — omission and "0" mean different things.
    const legacy = parseEventConfig(pubkey, [["d", "ev"], ["v", "2"], ["inbox", "b".repeat(64)]]);
    expect(legacy.maxVideoSec).toBe(90);
    expect(legacy.maxTalkSec).toBe(900);
    // A normal capped event (90/900) still round-trips exactly as before.
    const capped = buildEventConfig({ ...base, maxVideoSec: 90, maxTalkSec: 900 });
    expect(parseEventConfig(pubkey, capped.tags).maxVideoSec).toBe(90);
    expect(parseEventConfig(pubkey, capped.tags).maxTalkSec).toBe(900);
  });

  it("falls back to defaults for non-numeric / negative numeric tags (never NaN)", () => {
    const parsed = parseEventConfig(pubkey, [
      ["d", "ev"], ["v", "2"],
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

  // ── PROTO-5: inbox/coordinator pubkeys + relay/blossom URL validation ──────
  it("validates the inbox/coordinator pubkeys (fail-soft)", () => {
    // A malformed inbox is treated as missing → the required-tag throw fires.
    expect(() => parseEventConfig(pubkey, [["d", "ev"], ["v", "2"], ["inbox", "nothex"]])).toThrow();
    expect(() =>
      parseEventConfig(pubkey, [["d", "ev"], ["v", "2"], ["inbox", "B".repeat(64)]]),
    ).toThrow();
    // A malformed coordinator is dropped (optional tag → absent), never surfaced.
    const parsed = parseEventConfig(pubkey, [
      ["d", "ev"], ["v", "2"],
      ["inbox", "b".repeat(64)],
      ["coordinator", "nothex"],
    ]);
    expect(parsed.coordinator).toBeUndefined();
    const upper = parseEventConfig(pubkey, [
      ["d", "ev"], ["v", "2"],
      ["inbox", "b".repeat(64)],
      ["coordinator", "C".repeat(64)], // uppercase hex: dropped like any invalid value
    ]);
    expect(upper.coordinator).toBeUndefined();
    // A valid THREE-element coordinator tag (NIP §3.5) still parses, with its gen.
    const ok = parseEventConfig(pubkey, [
      ["d", "ev"], ["v", "2"],
      ["inbox", "b".repeat(64)],
      ["coordinator", "c".repeat(64), "2"],
    ]);
    expect(ok.coordinator).toBe("c".repeat(64));
    expect(ok.coordinatorGen).toBe(2);
  });

  // ── NIP §3.5: coordinator tag is three-element (pubkey + generation) ─────────
  it("treats a malformed coordinator tag as no coordinator (2-element / bad gen)", () => {
    // A 2-element tag (the v1 shape) has no generation → treated as no coordinator.
    const twoEl = parseEventConfig(pubkey, [
      ["d", "ev"], ["v", "2"],
      ["inbox", "b".repeat(64)],
      ["coordinator", "c".repeat(64)],
    ]);
    expect(twoEl.coordinator).toBeUndefined();
    expect(twoEl.coordinatorGen).toBeUndefined();
    // A non-positive-integer gen is likewise dropped.
    for (const gen of ["0", "-1", "x", "1.5"]) {
      const p = parseEventConfig(pubkey, [
        ["d", "ev"], ["v", "2"],
        ["inbox", "b".repeat(64)],
        ["coordinator", "c".repeat(64), gen],
      ]);
      expect(p.coordinator, `gen=${gen}`).toBeUndefined();
    }
  });

  it("buildEventConfig requires a positive coordinatorGen when a coordinator is set", () => {
    const base = {
      d: "ev", eidPubkey: pubkey, inbox: "b".repeat(64),
      relays: [], blossom: [], maxVideoSec: 90, maxTalkSec: 900,
      matching: "off" as const, matchVisibility: "pair" as const,
      approval: "manual" as const, eck: 1, nostrContext: 0, lang: "en",
      talks: "off" as const, chat: [],
    };
    // Coordinator with a gen → three-element tag.
    const built = buildEventConfig({ ...base, coordinator: "c".repeat(64), coordinatorGen: 4 });
    expect(built.tags).toContainEqual(["coordinator", "c".repeat(64), "4"]);
    // Coordinator without a gen → throws (a programming error in the organizer flow).
    expect(() => buildEventConfig({ ...base, coordinator: "c".repeat(64) })).toThrow();
    // No coordinator → no coordinator tag, no gen required.
    expect(buildEventConfig(base).tags.find((t) => t[0] === "coordinator")).toBeUndefined();
  });

  it("keeps only wss:// relay tags and https:// blossom tags", () => {
    const parsed = parseEventConfig(pubkey, [
      ["d", "ev"], ["v", "2"],
      ["inbox", "b".repeat(64)],
      ["relay", "wss://relay.a"],
      ["relay", "https://not-a-relay.example"],
      ["relay", "http://relay.b"],
      ["relay", "not a url"],
      ["blossom", "https://blossom.a"],
      ["blossom", "http://blossom.b"],
      ["blossom", "wss://nope"],
    ]);
    expect(parsed.relays).toEqual(["wss://relay.a"]);
    expect(parsed.blossom).toEqual(["https://blossom.a"]);
  });
});
