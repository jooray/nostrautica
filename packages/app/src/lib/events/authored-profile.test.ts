import { describe, it, expect } from "vitest";
import {
  fieldsFromProfile,
  buildAuthoredSubmission,
  authoredChanged,
  normalizeAuthoredProfile,
} from "./authored-profile.js";
import {
  attendeeProfileSchema,
  MAX_ABOUT,
  MAX_LINKS,
  MAX_SKILLS,
  type AttendeeProfile,
  type MediaDescriptor,
} from "@nostrautica/protocol";

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

/**
 * The coordinator does not reject a too-long or malformed field — it rejects the
 * SUBMISSION, permanently and silently (ZodError => "permanently unprocessable"
 * => marked seen). So every case here is really one assertion: whatever comes
 * out of normalization must parse against the schema the coordinator runs.
 */
describe("normalizeAuthoredProfile", () => {
  const parses = (p: AttendeeProfile) => attendeeProfileSchema.safeParse(p).success;

  it("repairs a scheme-less link rather than rejecting the submission", () => {
    const { profile, dropped } = normalizeAuthoredProfile({
      about: "",
      skills: [],
      looking_for: "",
      links: ["example.com/me", "https://already.example"],
    });
    expect(profile.links).toEqual(["https://example.com/me", "https://already.example/"]);
    expect(dropped).toEqual([]);
    expect(parses(profile)).toBe(true);
  });

  it("reports a link it cannot repair instead of dropping it silently", () => {
    const { profile, dropped } = normalizeAuthoredProfile({
      about: "",
      skills: [],
      looking_for: "",
      // A handle and a bare word are not hosts; the scheme'd ones are not links.
      links: ["@my_handle", "my_handle", "javascript:alert(1)", "mailto:a@b.example"],
    });
    expect(profile.links).toEqual([]);
    expect(dropped).toEqual(["@my_handle", "my_handle", "javascript:alert(1)", "mailto:a@b.example"]);
  });

  it("truncates an over-cap bio instead of losing the whole profile with it", () => {
    const { profile } = normalizeAuthoredProfile({
      about: "x".repeat(MAX_ABOUT + 500),
      skills: [],
      looking_for: "",
      links: [],
    });
    expect(profile.about).toHaveLength(MAX_ABOUT);
    expect(parses(profile)).toBe(true);
  });

  it("bounds and dedupes the list fields", () => {
    const { profile } = normalizeAuthoredProfile({
      about: "",
      skills: [...Array(MAX_SKILLS + 10).keys()].map((i) => `skill-${i}`).concat("skill-0"),
      looking_for: "",
      links: [...Array(MAX_LINKS + 5).keys()].map((i) => `https://link-${i}.example`),
    });
    expect(profile.skills).toHaveLength(MAX_SKILLS);
    expect(new Set(profile.skills).size).toBe(profile.skills.length);
    expect(profile.links).toHaveLength(MAX_LINKS);
    expect(parses(profile)).toBe(true);
  });

  it("leaves an ordinary profile alone", () => {
    const input: AttendeeProfile = {
      about: "Builder",
      skills: ["rust", "go"],
      looking_for: "co-founder",
      links: ["https://example.com/"],
    };
    expect(normalizeAuthoredProfile(input)).toEqual({ profile: input, dropped: [] });
  });
});
