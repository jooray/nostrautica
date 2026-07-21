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
});
