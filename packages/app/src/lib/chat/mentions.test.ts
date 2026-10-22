import { describe, it, expect } from "vitest";
import { decode, npubEncode, nprofileEncode } from "nostr-tools/nip19";
import {
  parseMentions,
  mentionPTags,
  shortNpub,
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
