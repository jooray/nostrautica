import { describe, it, expect } from "vitest";
import { generateEck, eckEncrypt } from "./crypto.js";
import {
  encryptMembersPost,
  decryptMembersPost,
  encryptEventPagePrivate,
  decryptEventPagePrivate,
  mergeMenu,
  splitMenu,
  mergeSections,
  splitSections,
  menuToRTags,
  rTagsToMenu,
  utf8ByteLength,
  MAX_MEMBERS_POST_MARKDOWN_BYTES,
  NIP44_MAX_PLAINTEXT_BYTES,
  MAX_THEME_CSS_BYTES,
} from "./event-page.js";
import {
  membersPostContentSchema,
  eventPageContentSchema,
  eventPagePrivateSchema,
  type MembersPostContent,
  type EventPagePrivate,
  type MenuItem,
  type EventPageSection,
} from "./schemas.js";
import type { z } from "zod";

const hex = "a".repeat(64);

const post: MembersPostContent = {
  v: 2,
  title: "Full schedule",
  summary: "with rooms and names",
  image: "https://blossom.example/pic.png",
  published_at: 1_752_000_000,
  author: hex,
  content: "## Day 1\n\n- 09:00 doors\n- 10:00 keynote",
};

function roundTrips<T>(schema: z.ZodType<T>, value: unknown) {
  const parsed = schema.parse(value);
  const again = schema.parse(JSON.parse(JSON.stringify(parsed)));
  expect(again).toEqual(parsed);
}

describe("31607 members-only post payload", () => {
  it("schema round-trips through JSON (optionals present and absent)", () => {
    roundTrips(membersPostContentSchema, post);
    roundTrips(membersPostContentSchema, {
      v: 2,
      title: "t",
      published_at: 1,
      content: "body",
    });
  });

  it("encrypts and decrypts under the same ECK", () => {
    const eck = generateEck();
    const ct = encryptMembersPost(eck, post);
    expect(decryptMembersPost(eck, ct)).toEqual(post);
  });

  it("rejects decryption with the wrong key", () => {
    const ct = encryptMembersPost(generateEck(), post);
    expect(() => decryptMembersPost(generateEck(), ct)).toThrow();
  });

  it("rejects markdown over the 60,000-byte editor cap", () => {
    const big = { ...post, content: "x".repeat(MAX_MEMBERS_POST_MARKDOWN_BYTES + 1) };
    expect(() => encryptMembersPost(generateEck(), big)).toThrow(/60000|limit/);
  });

  it("counts bytes, not code units (multibyte content near the cap)", () => {
    // "š" is 2 UTF-8 bytes: 30_001 × 2 > 60_000 even though length < cap.
    const sneaky = { ...post, content: "š".repeat(30_001) };
    expect(utf8ByteLength(sneaky.content)).toBeGreaterThan(MAX_MEMBERS_POST_MARKDOWN_BYTES);
    expect(() => encryptMembersPost(generateEck(), sneaky)).toThrow();
  });

  it("NIP-44 itself rejects a >65,535-byte plaintext", () => {
    const eck = generateEck();
    expect(() => eckEncrypt(eck, "x".repeat(NIP44_MAX_PLAINTEXT_BYTES + 1))).toThrow();
  });
});

describe("31608 event page content", () => {
  const sections: EventPageSection[] = [
    { type: "posts", source: "both", visibility: "public" },
    { type: "pinned", refs: ["naddr1abc"] },
    { type: "attendees" },
  ];

  it("public content schema round-trips (with and without private)", () => {
    roundTrips(eventPageContentSchema, { v: 2, sections, private: "ciphertext" });
    roundTrips(eventPageContentSchema, { v: 2, sections: [] });
  });

  it("external feeds round-trip, and a page published before they existed still parses", () => {
    const sources = [
      {
        pubkey: "a".repeat(64),
        tags: ["kosice"],
        since: 1_754_006_400,
        relays: ["wss://relay.example"],
        label: "Lunarpunk",
      },
      { pubkey: "b".repeat(64) }, // every narrowing field is optional
    ];
    roundTrips(eventPageContentSchema, { v: 2, sections, sources });

    // The migration property: `sources` is additive and defaulted, so every
    // 31608 already on a relay parses unchanged and simply declares no feeds.
    expect(eventPageContentSchema.parse({ v: 2, sections: [] }).sources).toEqual([]);
  });

  it("rejects a source that isn't a 32-byte hex pubkey", () => {
    // The editor accepts an npub and decodes it; anything reaching the wire as
    // an npub (or a display name) would silently match nothing.
    expect(() =>
      eventPageContentSchema.parse({ v: 2, sections: [], sources: [{ pubkey: "npub1abc" }] }),
    ).toThrow();
  });

  it("private payload schema round-trips", () => {
    roundTrips(eventPagePrivateSchema, {
      v: 2,
      menu: [{ label: "Secret map", target: "https://example.com/map", pos: 1 }],
      sections: [{ type: "posts", source: "event", visibility: "members", pos: 0 }],
    });
  });

  it("private payload encrypts/decrypts under the ECK; wrong key rejects", () => {
    const eck = generateEck();
    const priv: EventPagePrivate = {
      v: 2,
      menu: [{ label: "m", target: "nostr:naddr1x", pos: 0 }],
      sections: [{ type: "attendees", pos: 2 }],
    };
    const ct = encryptEventPagePrivate(eck, priv);
    expect(decryptEventPagePrivate(eck, ct)).toEqual(priv);
    expect(() => decryptEventPagePrivate(generateEck(), ct)).toThrow();
  });

  it("menu ⇄ r tags keeps display order and labels", () => {
    const menu: MenuItem[] = [
      { label: "Venue", target: "https://venue.example" },
      { label: "Schedule", target: "nostr:naddr1sched" },
    ];
    const tags = menuToRTags(menu);
    expect(tags).toEqual([
      ["r", "https://venue.example", "Venue"],
      ["r", "nostr:naddr1sched", "Schedule"],
    ]);
    expect(rTagsToMenu([["d", "ev"], ...tags, ["v", "2"]])).toEqual(menu);
  });
});

describe("merge/split of public + members-only items by pos", () => {
  const pub: MenuItem[] = [
    { label: "A", target: "https://a" },
    { label: "C", target: "https://c" },
  ];

  it("interleaves private items at their pos in the MERGED list", () => {
    const merged = mergeMenu(pub, [
      { label: "B", target: "https://b", pos: 1 },
      { label: "Z", target: "https://z", pos: 3 },
    ]);
    expect(merged.map((m) => m.label)).toEqual(["A", "B", "C", "Z"]);
    expect(merged.map((m) => m.membersOnly)).toEqual([false, true, false, true]);
  });

  it("clamps out-of-range pos instead of dropping items", () => {
    const merged = mergeMenu(pub, [{ label: "far", target: "https://f", pos: 99 }]);
    expect(merged.map((m) => m.label)).toEqual(["A", "C", "far"]);
  });

  it("handles adjacent private items and pos 0", () => {
    const merged = mergeMenu(pub, [
      { label: "P0", target: "https://p0", pos: 0 },
      { label: "P1", target: "https://p1", pos: 1 },
    ]);
    expect(merged.map((m) => m.label)).toEqual(["P0", "P1", "A", "C"]);
  });

  it("split is the exact inverse of merge (editor round-trip)", () => {
    const priv = [
      { label: "B", target: "https://b", pos: 1 },
      { label: "D", target: "https://d", pos: 3 },
    ];
    const merged = mergeMenu(pub, priv);
    const back = splitMenu(merged);
    expect(back.publicItems).toEqual(pub);
    expect(back.privateItems).toEqual(priv);
    expect(mergeMenu(back.publicItems, back.privateItems)).toEqual(merged);
  });

  it("sections merge the same way", () => {
    const merged = mergeSections(
      [{ type: "posts", source: "both", visibility: "public" }],
      [{ type: "attendees", pos: 0 }],
    );
    expect(merged.map((s) => s.type)).toEqual(["attendees", "posts"]);
    const back = splitSections(merged);
    expect(back.privateItems).toEqual([{ type: "attendees", pos: 0 }]);
    expect(mergeSections(back.publicItems, back.privateItems)).toEqual(merged);
  });
});

describe("theme cap constant", () => {
  it("is 32 KB", () => {
    expect(MAX_THEME_CSS_BYTES).toBe(32768);
  });
});
