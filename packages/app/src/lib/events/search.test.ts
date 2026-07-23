/**
 * Client-side directory search (spec §13): field coverage, normalization, and
 * name-first ranking over already-decrypted local data.
 */
import { describe, it, expect } from "vitest";
import type { DirectoryEntryContent } from "@nostrautica/protocol";
import { directoryEntryFields, searchRank, type SearchFields } from "./search.js";

function entry(over: Partial<DirectoryEntryContent> = {}): DirectoryEntryContent {
  return {
    v: 2,
    pubkey: "a".repeat(64),
    profile: { about: "", skills: [], looking_for: "", links: [] },
    media: [],
    updated_at: 1,
    ...over,
  } as DirectoryEntryContent;
}

describe("directoryEntryFields", () => {
  it("indexes authored profile, AI profile, intro text and transcripts", () => {
    const e = entry({
      profile: { about: "rust engineer", skills: ["nostr"], looking_for: "cofounder", links: [] },
      intro_text: "hi I build relays",
      ai_profile: {
        summary: "backend dev",
        skills: ["golang"],
        interests: ["climbing"],
        offers: ["mentoring"],
        seeks: ["funding"],
      },
      transcripts: [{ x: "b".repeat(64), text: "I mentioned lightning", lang: "en", source: "stt", updated_at: 1 }],
    });
    const f = directoryEntryFields(e, "Alice");
    const hay = [f.name, ...f.rest].join(" ").toLowerCase();
    for (const term of ["rust", "nostr", "cofounder", "relays", "backend", "golang", "climbing", "mentoring", "funding", "lightning"]) {
      expect(hay).toContain(term);
    }
  });

  it("folds in the AI translation only for the matching locale", () => {
    const e = entry({
      ai_profile: {
        summary: "s",
        skills: [],
        interests: [],
        offers: [],
        seeks: [],
        translations: { lang: "sk", about: "vývojár", skills: ["kryptografia"], looking_for: "" },
      },
    });
    expect(directoryEntryFields(e, "Bob", "sk").rest.join(" ")).toContain("vývojár");
    expect(directoryEntryFields(e, "Bob", "en").rest.join(" ")).not.toContain("vývojár");
  });
});

describe("searchRank", () => {
  const fieldsOf = (f: SearchFields) => f;
  const alice: SearchFields = { name: "Alice", rest: ["python developer"] };
  const bob: SearchFields = { name: "Bob", rest: ["rust, alice's project"] };
  const carol: SearchFields = { name: "Carol", rest: ["designer"] };

  it("empty query returns items unchanged", () => {
    const items = [alice, bob, carol];
    expect(searchRank(items, "  ", fieldsOf)).toBe(items);
  });

  it("ranks name matches ahead of body-only matches", () => {
    // "alice" matches Alice by name and Bob by body — Alice must come first.
    expect(searchRank([bob, alice, carol], "alice", fieldsOf)).toEqual([alice, bob]);
  });

  it("matches body fields when the name doesn't", () => {
    expect(searchRank([alice, bob, carol], "designer", fieldsOf)).toEqual([carol]);
  });

  it("requires all tokens and is diacritic-insensitive", () => {
    const jan: SearchFields = { name: "Ján Novák", rest: ["rust"] };
    expect(searchRank([jan], "jan rust", fieldsOf)).toEqual([jan]);
    expect(searchRank([jan], "jan python", fieldsOf)).toEqual([]);
  });
});
