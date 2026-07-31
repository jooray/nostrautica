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
import { buildAiProfile, summarizeNostr, translateProfileFields, nostrInputsHash } from "./profile.js";
import { MAX_ABOUT, MAX_LOOKING_FOR, type AttendeeProfile } from "@nostrautica/protocol";

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

  it("folds a kind-0 profile's about bio into the prompt as a labeled line, not raw JSON", async () => {
    let capturedUser = "";
    const llm = new MockLlm((req: any) => {
      capturedUser = req.user;
      return { summary: "Works on Nostr clients." };
    });
    const out = await summarizeNostr(llm, summaryModel, "pk", [
      { kind: 0, content: JSON.stringify({ name: "sam", about: "Builds Nostr clients." }), created_at: 2 },
    ]);
    expect(out).toBe("Works on Nostr clients.");
    expect(capturedUser).toContain("Profile bio: Builds Nostr clients.");
    expect(capturedUser).not.toContain("{\"name\"");
  });

  it("skips the LLM call entirely when the only input is a kind-0 event with no usable bio", async () => {
    let called = false;
    const llm = new MockLlm(() => {
      called = true;
      return { summary: "n/a" };
    });
    const out = await summarizeNostr(llm, summaryModel, "pk", [
      { kind: 0, content: JSON.stringify({ name: "sam" }), created_at: 2 },
    ]);
    expect(out).toBeUndefined();
    expect(called).toBe(false);
  });
});

describe("nostrInputsHash (audit COORD-22)", () => {
  it("hashes FULL post content — a shared 40-char prefix never collides", () => {
    const shared = "we should all meet at https://conference.example and talk about ";
    const a = nostrInputsHash("pk", [{ kind: 1, content: `${shared}ZK proofs`, created_at: 1 }]);
    const b = nostrInputsHash("pk", [{ kind: 1, content: `${shared}UX design`, created_at: 1 }]);
    expect(a).not.toBe(b);
    // Same content → stable hash (cache hit).
    const a2 = nostrInputsHash("pk", [{ kind: 1, content: `${shared}ZK proofs`, created_at: 1 }]);
    expect(a2).toBe(a);
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

  // Production 2026-07-29: this exact payload shape poisoned three attendees'
  // pipelines. The system prompt says to translate each NON-EMPTY field, and the
  // model marks the ones it skipped with null — which `.optional()` rejected as
  // `looking_for: invalid_type`, deterministically, so every retry re-billed a
  // call that could never pass.
  it("accepts null for the fields the model was told to skip (empty author fields)", async () => {
    const llm = new MockLlm(() => ({
      source_lang: "en",
      needs_translation: true,
      about: "o mne",
      looking_for: null,
      skills: null,
    }));
    const out = await translateProfileFields(llm, summaryModel, "sk", {
      about: "about me",
      looking_for: "", // blank, so the model had nothing to translate
      skills: [],
    });
    expect(out?.about).toBe("o mne");
    expect(out?.looking_for).toBeUndefined();
    expect(out?.skills).toBeUndefined();
  });

  // Seen on the first real run after the null fix deployed: the model returned
  // `skills` as one comma-joined string. Same attendee's ai_profile call returned
  // the same terms as a proper array, so it splits an authored skill into several
  // and then joins them back on the way out.
  it("accepts a comma-joined skills string and splits it back into a list", async () => {
    const llm = new MockLlm(() => ({
      source_lang: "en",
      needs_translation: true,
      about: "o mne",
      skills: "krypto, AI, hackovanie, bezpečnosť",
    }));
    const out = await translateProfileFields(llm, summaryModel, "sk", {
      about: "about me",
      looking_for: "",
      skills: ["crypto hacking ai security"],
    });
    expect(out?.skills).toEqual(["krypto", "AI", "hackovanie", "bezpečnosť"]);
    expect(out?.about).toBe("o mne");
  });

  // Two attendees' process_attendee POISONED on this in July (jobs 51 and 70:
  // "looking_for: invalid_type; skills: invalid_type") and stayed unprocessed for
  // two weeks. The 2026-07-30 coercion covered `skills` and left the prose fields
  // strict, so a model returning a LIST where a paragraph was asked for still
  // killed the whole stage — and with it the attendee's profile, directory entry
  // and every match they would have had.
  it("accepts a list where prose was asked for, joining it instead of failing", async () => {
    const llm = new MockLlm(() => ({
      source_lang: "es",
      needs_translation: true,
      about: ["Builds privacy tools", "runs a meetup"],
      looking_for: ["a designer", "a co-founder"],
      skills: ["zk"],
    }));
    const out = await translateProfileFields(llm, summaryModel, "en", fields);
    expect(out?.about).toBe("Builds privacy tools, runs a meetup");
    expect(out?.looking_for).toBe("a designer, a co-founder");
  });

  it("drops prose the model returned as junk rather than failing the stage", async () => {
    const llm = new MockLlm(() => ({
      source_lang: "es",
      needs_translation: true,
      about: 42,
      looking_for: { text: "nope" },
      skills: ["zk"],
    }));
    const out = await translateProfileFields(llm, summaryModel, "en", fields);
    // Unusable prose is simply not published — the attendee sees their own words.
    expect(out?.about).toBeUndefined();
    expect(out?.looking_for).toBeUndefined();
    expect(out?.skills).toEqual(["zk"]);
  });

  it("bounds translated prose to the protocol caps so readers can still parse it", async () => {
    // An over-cap value encrypts and publishes fine, then fails every reader's
    // directoryEntryContentSchema.parse — the attendee vanishes from the
    // directory for everyone. Same reasoning as the skills bound.
    const llm = new MockLlm(() => ({
      source_lang: "es",
      needs_translation: true,
      about: "x".repeat(MAX_ABOUT + 500),
      looking_for: "y".repeat(MAX_LOOKING_FOR + 500),
      skills: ["zk"],
    }));
    const out = await translateProfileFields(llm, summaryModel, "en", fields);
    expect(out!.about!.length).toBe(MAX_ABOUT);
    expect(out!.looking_for!.length).toBe(MAX_LOOKING_FOR);
  });

  it("drops non-string items from a skills array instead of failing the stage", async () => {
    const llm = new MockLlm(() => ({
      source_lang: "en",
      needs_translation: true,
      skills: ["zk", 42, null, "  ", "rust"],
    }));
    const out = await translateProfileFields(llm, summaryModel, "sk", fields);
    expect(out?.skills).toEqual(["zk", "rust"]);
  });

  it("an unusable skills value yields no skills rather than an error", async () => {
    const llm = new MockLlm(() => ({
      source_lang: "en",
      needs_translation: true,
      about: "o mne",
      skills: { nope: true },
    }));
    const out = await translateProfileFields(llm, summaryModel, "sk", {
      about: "about me",
      looking_for: "",
      skills: ["zk"],
    });
    expect(out?.about).toBe("o mne"); // the good field still publishes
    expect(out?.skills).toBeUndefined();
  });

  it("null on EVERY translated field yields no translation rather than an error", async () => {
    const llm = new MockLlm(() => ({
      source_lang: "en",
      needs_translation: true,
      about: null,
      looking_for: null,
      skills: null,
    }));
    await expect(translateProfileFields(llm, summaryModel, "sk", fields)).resolves.toBeUndefined();
  });
});
