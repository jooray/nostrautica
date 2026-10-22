import { describe, it, expect } from "vitest";
import { decode, npubEncode, nprofileEncode } from "nostr-tools/nip19";
import {
  parseMentions,
  mentionPTags,
  shortNpub,
  activeMention,
  insertMention,
  deleteMentionBackward,
  matchMentionCandidates,
} from "./mentions.js";

// The message White Noise actually sent (owner report 2026-10-23): our bubble
// showed this npub raw instead of a name.
const WN_NPUB = "npub1fngg32tel6hy5rnq2dmsevmtezu0th5ql23s9a2p3ake3pdx73yslx5jqt";
const WN_HEX = decode(WN_NPUB).data as string;
const OTHER_HEX = "b".repeat(64);
const OTHER_NPUB = npubEncode(OTHER_HEX);

describe("parseMentions", () => {
  it("turns White Noise's `@npub1…` into a mention", () => {
    expect(parseMentions(`Nazdar @${WN_NPUB}`)).toEqual([
      { type: "text", value: "Nazdar " },
      { type: "mention", pubkey: WN_HEX, raw: `@${WN_NPUB}` },
    ]);
  });

  it("reads nostr:npub, nostr:nprofile and a bare npub as the same person", () => {
    const nprofile = nprofileEncode({ pubkey: WN_HEX, relays: ["wss://relay.example"] });
    for (const form of [`nostr:${WN_NPUB}`, `nostr:${nprofile}`, WN_NPUB, `@nostr:${WN_NPUB}`]) {
      const segs = parseMentions(`hi ${form}, welcome`);
      expect(segs, form).toEqual([
        { type: "text", value: "hi " },
        { type: "mention", pubkey: WN_HEX, raw: form },
        { type: "text", value: ", welcome" },
      ]);
    }
  });

  it("leaves e-mail-like, path-embedded and corrupt npubs as text", () => {
    // Same boundary rule as MDK's tokenizer: a letter, digit, `_` or `/` on
    // either side keeps the run literal.
    for (const s of [
      `mail me@${WN_NPUB}`,
      `https://njump.me/${WN_NPUB}`,
      `@${WN_NPUB}x`,
      `@${WN_NPUB.slice(0, -1)}q`, // checksum broken
      "nostr:note1qqqqqqqqqqqqqq", // not a person
    ]) {
      expect(parseMentions(s).every((x) => x.type === "text"), s).toBe(true);
    }
  });

  it("finds several mentions and keeps the text between them", () => {
    const segs = parseMentions(`@${WN_NPUB} and @${OTHER_NPUB}!`);
    expect(segs.map((s) => s.type)).toEqual(["mention", "text", "mention", "text"]);
  });

  it("returns plain text untouched", () => {
    expect(parseMentions("no one here")).toEqual([{ type: "text", value: "no one here" }]);
    expect(parseMentions("")).toEqual([]);
  });
});

describe("mentionPTags (MDK mention_p_tags)", () => {
  it("adds one p tag per distinct person, first-seen order", () => {
    expect(mentionPTags(`@${OTHER_NPUB} @${WN_NPUB} nostr:${OTHER_NPUB}`)).toEqual([
      ["p", OTHER_HEX],
      ["p", WN_HEX],
    ]);
    expect(mentionPTags("nobody")).toEqual([]);
  });
});

describe("shortNpub", () => {
  it("keeps the npub1 prefix and the last four characters", () => {
    expect(shortNpub(WN_HEX)).toBe("npub1fngg…5jqt");
  });
});

describe("composer: activeMention / insertMention", () => {
  it("opens on an `@` that starts a word, up to the caret", () => {
    expect(activeMention("hi @ju", 6)).toEqual({ start: 3, query: "ju" });
    expect(activeMention("@", 1)).toEqual({ start: 0, query: "" });
    expect(activeMention("mail a@b", 8)).toBeNull();
    expect(activeMention("hi @ju there", 12)).toBeNull();
  });

  it("does not reopen inside an inserted chip", () => {
    const text = `@${WN_NPUB}`;
    expect(activeMention(text, text.length)).toBeNull();
    expect(activeMention(text, 5)).toBeNull();
  });

  it("inserts the exact White Noise form with one trailing space", () => {
    const r = insertMention("hi @ju", { start: 3, query: "ju" }, WN_HEX);
    expect(r.text).toBe(`hi @${WN_NPUB} `);
    expect(r.caret).toBe(r.text.length);
    // Mid-sentence: the following space is reused, not doubled.
    const mid = insertMention("hi @ju there", { start: 3, query: "ju" }, WN_HEX);
    expect(mid.text).toBe(`hi @${WN_NPUB} there`);
    expect(mid.caret).toBe(`hi @${WN_NPUB}`.length);
    expect(mentionPTags(r.text)).toEqual([["p", WN_HEX]]);
  });

  it("backspace removes a whole chip, with or without its space", () => {
    const text = `hi @${WN_NPUB} `;
    expect(deleteMentionBackward(text, text.length)).toEqual({ text: "hi ", caret: 3 });
    expect(deleteMentionBackward(text, text.length - 1)).toEqual({ text: "hi  ", caret: 3 });
    expect(deleteMentionBackward("hello", 5)).toBeNull();
  });
});

describe("matchMentionCandidates", () => {
  const people = [
    { account: WN_HEX, name: "Juraj" },
    { account: OTHER_HEX, name: "Mária Juraj" },
    { account: "c".repeat(64), name: "stallion" },
  ];
  it("ranks prefix matches before substring matches", () => {
    expect(matchMentionCandidates(people, "jur").map((p) => p.name)).toEqual(["Juraj", "Mária Juraj"]);
  });
  it("lists everyone for an empty query and finds a typed npub", () => {
    expect(matchMentionCandidates(people, "")).toHaveLength(3);
    expect(matchMentionCandidates(people, WN_NPUB.slice(0, 12))).toEqual([people[0]]);
  });
});
