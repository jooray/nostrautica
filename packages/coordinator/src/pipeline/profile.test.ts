/**
 * Provider-output runtime validation (spec §9.2/§9.3, audit finding Q9). Every AI
 * response is schema-checked at the provider boundary: malformed output raises a
 * ProviderContractError instead of propagating a bad value into storage or
 * publication. The mock provider runs the same `validate` hook as Venice/Routstr,
 * so these tests exercise the real contract.
 */
import { describe, it, expect } from "vitest";
import { MockLlm } from "../providers/mock.js";
import { ProviderContractError } from "../providers/types.js";
import { buildAiProfile, summarizeNostr, translateProfileFields } from "./profile.js";
import type { AttendeeProfile } from "@nostrautica/protocol";

const matchModel = { provider: "mock", model: "mock-strong" };
const summaryModel = { provider: "mock", model: "mock-cheap" };

const goodProfile = {
  summary: "A cryptographer who builds privacy tools.",
  skills: ["zk", "rust"],
  interests: ["privacy"],
  offers: ["mentoring"],
  seeks: ["a designer"],
};

const attendee: AttendeeProfile = {
  about: "cryptographer",
  skills: ["zk"],
  looking_for: "a designer",
  links: [],
};

describe("Q9 — buildAiProfile validates provider output", () => {
  it("accepts a well-formed ai_profile", async () => {
    const llm = new MockLlm(() => goodProfile);
    const out = await buildAiProfile(llm, matchModel, {
      transcripts: ["hi"],
      profile: attendee,
    });
    expect(out.summary).toBe(goodProfile.summary);
    expect(out.skills).toEqual(["zk", "rust"]);
  });

  it("rejects output missing a required field", async () => {
    // `seeks` omitted — a downstream consumer would otherwise crash on undefined.
    const { seeks: _seeks, ...broken } = goodProfile;
    const llm = new MockLlm(() => broken);
    await expect(
      buildAiProfile(llm, matchModel, { transcripts: [], profile: attendee }),
    ).rejects.toBeInstanceOf(ProviderContractError);
  });

  it("rejects output with a wrong-typed field", async () => {
    const llm = new MockLlm(() => ({ ...goodProfile, skills: "zk" }));
    await expect(
      buildAiProfile(llm, matchModel, { transcripts: [], profile: attendee }),
    ).rejects.toBeInstanceOf(ProviderContractError);
  });

  it("rejects a non-object (e.g. truncated JSON that parsed to a string)", async () => {
    const llm = new MockLlm(() => "not an object");
    await expect(
      buildAiProfile(llm, matchModel, { transcripts: [], profile: attendee }),
    ).rejects.toBeInstanceOf(ProviderContractError);
  });

  it("contract error carries sanitized diagnostics (paths, not attendee text)", async () => {
    const { summary: _summary, ...broken } = goodProfile;
    const llm = new MockLlm(() => broken);
    try {
      await buildAiProfile(llm, matchModel, {
        transcripts: ["SECRET attendee transcript"],
        profile: attendee,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderContractError);
      const err = e as ProviderContractError;
      expect(err.provider).toBe("mock");
      expect(err.schemaName).toBe("ai_profile");
      expect(err.detail).toContain("summary");
      // No prompt / attendee content leaks into the poison diagnostics.
      expect(err.message).not.toContain("SECRET");
    }
  });
});

describe("Q9 — summarizeNostr validates provider output", () => {
  it("rejects a summary that isn't a string", async () => {
    const llm = new MockLlm(() => ({ summary: 42 }));
    await expect(
      summarizeNostr(llm, summaryModel, "pk", [{ kind: 1, content: "gm", created_at: 1 }]),
    ).rejects.toBeInstanceOf(ProviderContractError);
  });

  it("accepts a valid summary", async () => {
    const llm = new MockLlm(() => ({ summary: "Builds privacy tools." }));
    const out = await summarizeNostr(llm, summaryModel, "pk", [
      { kind: 1, content: "gm", created_at: 1 },
    ]);
    expect(out).toBe("Builds privacy tools.");
  });
});

describe("Q9 — translateProfileFields validates provider output", () => {
  const fields = { about: "hola", looking_for: "un diseñador", skills: ["zk"] };

  it("rejects when the required needs_translation flag is missing", async () => {
    const llm = new MockLlm(() => ({ source_lang: "es" }));
    await expect(
      translateProfileFields(llm, summaryModel, "en", fields),
    ).rejects.toBeInstanceOf(ProviderContractError);
  });

  it("accepts a valid translation response", async () => {
    const llm = new MockLlm(() => ({
      source_lang: "es",
      needs_translation: true,
      about: "hello",
      looking_for: "a designer",
      skills: ["zk"],
    }));
    const out = await translateProfileFields(llm, summaryModel, "en", fields);
    expect(out?.about).toBe("hello");
    expect(out?.lang).toBe("en");
  });
});
