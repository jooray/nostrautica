import { describe, it, expect } from "vitest";
import {
  mergeProfileContent,
  mergeFollowTags,
  removeFollowTag,
  isFollowing,
} from "./onboarding.js";

describe("kind-0 profile merge (spec §5.4)", () => {
  it("preserves unknown JSON fields and only updates edited ones", () => {
    const existing = JSON.stringify({
      name: "old",
      about: "keep me",
      nip05: "alice@example.com",
      customField: { deep: true },
    });
    const merged = JSON.parse(mergeProfileContent(existing, { name: "new" }));
    expect(merged.name).toBe("new"); // edited
    expect(merged.about).toBe("keep me"); // preserved
    expect(merged.nip05).toBe("alice@example.com"); // preserved
    expect(merged.customField).toEqual({ deep: true }); // preserved unknown field
  });

  it("ignores undefined edits (leave-as-is)", () => {
    const merged = JSON.parse(
      mergeProfileContent(JSON.stringify({ name: "x", about: "y" }), {
        name: undefined,
        picture: "https://img",
      }),
    );
    expect(merged.name).toBe("x");
    expect(merged.picture).toBe("https://img");
  });

  it("handles missing/malformed existing profiles", () => {
    expect(JSON.parse(mergeProfileContent(undefined, { name: "n" })).name).toBe("n");
    expect(JSON.parse(mergeProfileContent("not json", { name: "n" })).name).toBe("n");
  });
});

describe("kind-3 follow merge-append (THE data-loss regression, spec §5.4)", () => {
  it("appends without wiping pre-existing follows", () => {
    const existing = [
      ["p", "aaaa", "wss://relay.example", "alice"],
      ["p", "bbbb"],
      ["t", "nostr"], // non-p tag must survive
    ];
    const merged = mergeFollowTags(existing, ["cccc"]);
    // all originals preserved, with their relay/petname fields intact
    expect(merged).toContainEqual(["p", "aaaa", "wss://relay.example", "alice"]);
    expect(merged).toContainEqual(["p", "bbbb"]);
    expect(merged).toContainEqual(["t", "nostr"]);
    // new follow appended
    expect(merged).toContainEqual(["p", "cccc"]);
    expect(merged.filter((t) => t[0] === "p")).toHaveLength(3);
  });

  it("does not duplicate an already-followed pubkey", () => {
    const existing = [["p", "aaaa", "wss://r", "alice"]];
    const merged = mergeFollowTags(existing, ["aaaa"]);
    expect(merged.filter((t) => t[0] === "p")).toHaveLength(1);
    // existing petname/relay preserved (not overwritten by the bare append)
    expect(merged[0]).toEqual(["p", "aaaa", "wss://r", "alice"]);
  });

  it("appends to an empty list", () => {
    expect(mergeFollowTags([], ["aaaa"])).toEqual([["p", "aaaa"]]);
  });

  it("removeFollowTag / isFollowing", () => {
    const tags = mergeFollowTags([["t", "x"]], ["aaaa", "bbbb"]);
    expect(isFollowing(tags, "aaaa")).toBe(true);
    const after = removeFollowTag(tags, "aaaa");
    expect(isFollowing(after, "aaaa")).toBe(false);
    expect(isFollowing(after, "bbbb")).toBe(true);
    expect(after).toContainEqual(["t", "x"]);
  });
});
