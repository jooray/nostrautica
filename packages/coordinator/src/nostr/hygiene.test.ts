/**
 * Publish-boundary output hygiene (audit COORD-12): LLM-authored text is
 * length-capped on a word boundary and URLs are neutralized (scheme stripped)
 * so injected content stays readable but never clickable.
 */
import { describe, it, expect } from "vitest";
import {
  truncateWords,
  neutralizeUrls,
  sanitizeLlmText,
  sanitizeAiProfile,
  MAX_LLM_TEXT_CHARS,
} from "./hygiene.js";
import { MAX_SKILLS, MAX_SKILL, aiProfileSchema } from "@nostrautica/protocol";

describe("truncateWords", () => {
  it("keeps short text intact", () => {
    expect(truncateWords("hello world", 100)).toBe("hello world");
  });
  it("truncates on a word boundary, not mid-word", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta";
    const out = truncateWords(text, 20);
    expect(out.length).toBeLessThanOrEqual(21); // + the ellipsis
    expect(out).not.toMatch(/gam$/); // didn't cut inside "gamma"
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("neutralizeUrls", () => {
  it("strips http(s) schemes so nothing is auto-linkified", () => {
    expect(neutralizeUrls("visit https://evil.example/x now")).toBe("visit evil.example/x now");
    expect(neutralizeUrls("see http://a.example and HTTPS://b.example")).toBe("see a.example and b.example");
  });
  it("leaves ordinary text alone", () => {
    expect(neutralizeUrls("no links here")).toBe("no links here");
  });
});

describe("sanitizeLlmText (audit COORD-12)", () => {
  it("caps at 2000 chars AND neutralizes URLs", () => {
    const text = `meet them! https://evil.example ${"x".repeat(MAX_LLM_TEXT_CHARS)}`;
    const out = sanitizeLlmText(text);
    expect(out).not.toContain("https://");
    expect(out.length).toBeLessThanOrEqual(MAX_LLM_TEXT_CHARS);
  });
});

describe("sanitizeAiProfile", () => {
  it("sanitizes summary + list fields without touching structure", () => {
    const p = sanitizeAiProfile({
      summary: "great person, see https://spam.example",
      skills: ["rust", "https://bad.example"],
      interests: [],
      offers: [],
      seeks: ["collaborators"],
    });
    expect(p.summary).toBe("great person, see spam.example");
    expect(p.skills).toEqual(["rust", "bad.example"]);
    expect(p.seeks).toEqual(["collaborators"]);
  });

  it("caps translated skills at the SCHEMA limit, not this file's looser one", () => {
    // `translations` is attached after aiProfileSchema validated the model output,
    // so this is the only enforcement of its item count. Over-cap publishes fine
    // and then fails directoryEntryContentSchema.parse in every reader — the
    // attendee silently disappears from the directory (2026-07-30).
    const p = sanitizeAiProfile({
      summary: "s",
      skills: [],
      interests: [],
      offers: [],
      seeks: [],
      translations: {
        lang: "sk",
        skills: Array.from({ length: MAX_SKILLS + 20 }, (_, i) => `skill-${i}`),
      },
    });
    expect(p.translations!.skills!.length).toBe(MAX_SKILLS);
    // Round-trips through the schema that readers actually parse with.
    expect(() => aiProfileSchema.parse(p)).not.toThrow();
  });

  it("truncates an over-long translated skill to the schema's per-item cap", () => {
    const p = sanitizeAiProfile({
      summary: "s",
      skills: [],
      interests: [],
      offers: [],
      seeks: [],
      translations: { lang: "sk", skills: ["x".repeat(MAX_SKILL + 500)] },
    });
    expect(p.translations!.skills![0]!.length).toBeLessThanOrEqual(MAX_SKILL);
    expect(() => aiProfileSchema.parse(p)).not.toThrow();
  });
});
