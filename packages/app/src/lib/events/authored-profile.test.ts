import { describe, it, expect } from "vitest";
import {
  fieldsFromProfile,
  buildAuthoredSubmission,
  authoredChanged,
} from "./authored-profile.js";
import type { MediaDescriptor } from "@nostrautica/protocol";

// Opaque descriptor — the model passes media through by reference; the exact
// shape doesn't matter for these tests.
const media = [{ kind: "intro" }] as unknown as MediaDescriptor[];

describe("authored-profile editing (UX-O3)", () => {
  it("seeds the form from a profile, joining list fields", () => {
    const f = fieldsFromProfile(
      { about: "hi", skills: ["rust", "ts"], looking_for: "cofounder", links: ["https://a.co", "https://b.co"] },
      "text intro",
    );
    expect(f.about).toBe("hi");
    expect(f.skills).toBe("rust, ts");
    expect(f.links).toBe("https://a.co\nhttps://b.co");
    expect(f.introText).toBe("text intro");
  });

  it("builds a submission, parsing lists and preserving media", () => {
    const { profile, introText, media: out } = buildAuthoredSubmission(
      { about: " hi ", skills: "rust,  ts ,", lookingFor: "cofounder", links: "https://a.co\nhttps://b.co", introText: " hello " },
      media,
    );
    expect(profile.about).toBe("hi");
    expect(profile.skills).toEqual(["rust", "ts"]);
    expect(profile.links).toEqual(["https://a.co", "https://b.co"]);
    expect(introText).toBe("hello");
    expect(out).toBe(media); // media passed through untouched
  });

  it("empty text intro becomes undefined, not an empty string", () => {
    expect(buildAuthoredSubmission({ about: "", skills: "", lookingFor: "", links: "", introText: "   " }, []).introText).toBeUndefined();
  });

  it("detects changes vs the seeded baseline", () => {
    const base = fieldsFromProfile({ about: "hi", skills: ["rust"], looking_for: "", links: [] }, "");
    expect(authoredChanged(base, base)).toBe(false);
    expect(authoredChanged({ ...base, about: "changed" }, base)).toBe(true);
    expect(authoredChanged({ ...base, skills: "rust, go" }, base)).toBe(true);
    // Whitespace-only difference is not a change.
    expect(authoredChanged({ ...base, about: "hi  " }, base)).toBe(false);
  });
});
