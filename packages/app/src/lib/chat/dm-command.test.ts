import { describe, it, expect } from "vitest";
import { parseDmCommand, matchDmTargets, type DmTarget } from "./dm-command.js";

const JURAJ: DmTarget = { account: "a".repeat(64), name: "Juraj" };
const JURAJ_B: DmTarget = { account: "b".repeat(64), name: "Juraj Bednár" };
const STALLION: DmTarget = { account: "c".repeat(64), name: "stallion" };
const ROOM = [JURAJ, JURAJ_B, STALLION];

describe("parseDmCommand", () => {
  it("leaves ordinary messages alone", () => {
    expect(parseDmCommand("hello world", ROOM)).toBeNull();
    expect(parseDmCommand("", ROOM)).toBeNull();
    // The command has to be the whole word: a message that merely starts with
    // the letters must reach the room like any other.
    expect(parseDmCommand("/msgpack is a format", ROOM)).toBeNull();
    expect(parseDmCommand("/mention me", ROOM)).toBeNull();
    expect(parseDmCommand("not /msg stallion hi", ROOM)).toBeNull();
  });

  it("opens the picker for a bare command, in both spellings", () => {
    for (const draft of ["/m", "/msg", "/m ", "/msg ", "/MSG "]) {
      expect(parseDmCommand(draft, ROOM)).toEqual({ ready: false, query: "" });
    }
  });

  it("keeps picking while the name is incomplete", () => {
    expect(parseDmCommand("/msg stal", ROOM)).toEqual({ ready: false, query: "stal" });
  });

  it("settles on a name and takes the rest as the message", () => {
    expect(parseDmCommand("/msg stallion ahoj", ROOM)).toEqual({
      ready: true,
      target: STALLION,
      body: "ahoj",
    });
    // /query: a settled recipient with nothing to say just opens the thread.
    expect(parseDmCommand("/msg stallion ", ROOM)).toEqual({
      ready: true,
      target: STALLION,
      body: "",
    });
  });

  it("does not let a short name swallow a longer one", () => {
    // "Juraj" is a complete member name AND a prefix of another. Until the user
    // commits with a space, the picker stays open so "Juraj Bednár" is reachable.
    expect(parseDmCommand("/msg Juraj", ROOM)).toEqual({ ready: false, query: "Juraj" });
    // A space commits to the shorter one…
    expect(parseDmCommand("/msg Juraj hi", ROOM)).toEqual({
      ready: true,
      target: JURAJ,
      body: "hi",
    });
    // …and the longer name still wins when it is actually typed out, which is
    // the whole reason the match is longest-first rather than first-wins.
    expect(parseDmCommand("/msg Juraj Bednár hi", ROOM)).toEqual({
      ready: true,
      target: JURAJ_B,
      body: "hi",
    });
  });

  it("settles immediately when no longer name shares the prefix", () => {
    expect(parseDmCommand("/msg stallion", ROOM)).toEqual({
      ready: true,
      target: STALLION,
      body: "",
    });
  });

  it("matches names case-insensitively", () => {
    expect(parseDmCommand("/msg STALLION hi", ROOM)).toEqual({
      ready: true,
      target: STALLION,
      body: "hi",
    });
  });

  it("stays in the picker when nothing matches, so nothing reaches the room", () => {
    expect(parseDmCommand("/msg nobody at all", ROOM)).toEqual({
      ready: false,
      query: "nobody at all",
    });
  });

  it("keeps a multi-line message body", () => {
    const c = parseDmCommand("/msg stallion first\nsecond", ROOM);
    expect(c).toEqual({ ready: true, target: STALLION, body: "first\nsecond" });
  });
});

describe("matchDmTargets", () => {
  it("lists everyone for an empty query", () => {
    expect(matchDmTargets(ROOM, "")).toEqual(ROOM);
  });

  it("puts prefix matches ahead of contains matches", () => {
    const hits = matchDmTargets([STALLION, JURAJ], "al");
    // "stallion" only contains "al"; nothing starts with it.
    expect(hits).toEqual([STALLION]);
    const mixed = matchDmTargets([{ account: "d".repeat(64), name: "Alma" }, STALLION], "al");
    expect(mixed.map((x) => x.name)).toEqual(["Alma", "stallion"]);
  });

  it("is case-insensitive and bounded", () => {
    expect(matchDmTargets(ROOM, "JUR").map((x) => x.name)).toEqual(["Juraj", "Juraj Bednár"]);
    expect(matchDmTargets(ROOM, "", 2)).toHaveLength(2);
  });
});
