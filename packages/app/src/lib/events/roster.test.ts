/**
 * Roster search matching (audit finding U8). Must find a known person by any
 * indexed field, accent-insensitively, including Slovak diacritics.
 */
import { describe, it, expect } from "vitest";
import { normalizeForSearch, matchesQuery, buildSearchText } from "./roster.js";

describe("normalizeForSearch", () => {
  it("folds diacritics and case", () => {
    expect(normalizeForSearch("Ján Škoda")).toBe("jan skoda");
    expect(normalizeForSearch("MĚŠŤAN")).toBe("mestan");
  });
});

describe("matchesQuery", () => {
  const hay = buildSearchText(["Ján Novák", "rust developer", ["nostr", "cryptography"], undefined]);

  it("empty query matches everything", () => {
    expect(matchesQuery(hay, "")).toBe(true);
    expect(matchesQuery(hay, "   ")).toBe(true);
  });
  it("matches by name accent-insensitively either direction", () => {
    expect(matchesQuery(hay, "jan")).toBe(true); // query without accent
    expect(matchesQuery("jan novak", "Ján")).toBe(true); // query with accent
  });
  it("matches by skill and bio", () => {
    expect(matchesQuery(hay, "rust")).toBe(true);
    expect(matchesQuery(hay, "cryptography")).toBe(true);
  });
  it("requires all tokens (AND)", () => {
    expect(matchesQuery(hay, "jan rust")).toBe(true);
    expect(matchesQuery(hay, "jan python")).toBe(false);
  });
});

describe("buildSearchText", () => {
  it("flattens strings and arrays, skipping empties", () => {
    expect(buildSearchText(["a", ["b", "c"], undefined, null, ""])).toBe("a b c");
  });
});
