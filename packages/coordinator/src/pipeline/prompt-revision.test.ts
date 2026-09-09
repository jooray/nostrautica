/**
 * A prompt edit must invalidate what that prompt produced (audit PIPE-3).
 *
 * Every expensive stage here is content-addressed, which is why a restart
 * mid-pipeline costs nothing. But "inputs" did not include the PROMPT:
 * `profileInputsHash` and `translationInputsHash` carried a hand-written
 * `"ai_profile.v1"` string that nobody ever bumped, `nostrInputsHash` carried no
 * such field at all, and `pairInputsHash` — guarding the most expensive stage —
 * carried neither the prompt nor even the model. So editing a prompt, or pointing
 * a role at a different model, invalidated nothing: the change deployed, every
 * lookup still hit the artifact the OLD prompt produced, and the edit appeared to
 * do nothing. From outside, "the cache is working" and "the change did not apply"
 * are indistinguishable.
 *
 * These tests pin the property rather than any particular digest, so editing a
 * prompt does not require editing a fixture.
 */
import { describe, it, expect } from "vitest";
import { sha256Hex, utf8ToBytes, type AttendeeProfile } from "@nostrautica/protocol";
import { promptRevision } from "./prompt-revision.js";
import { profileInputsHash, translationInputsHash, nostrInputsHash } from "./profile.js";
import { pairInputsHash, matchPromptRevision } from "../matching/scoring.js";

const profile: AttendeeProfile = {
  about: "builds privacy tools",
  skills: ["zk"],
  looking_for: "a designer",
  links: [],
};

describe("promptRevision", () => {
  it("changes when the prompt text changes, and is stable when it doesn't", () => {
    const a = promptRevision("Summarize this person.", { type: "object" });
    const b = promptRevision("Summarize this person concisely.", { type: "object" });
    const a2 = promptRevision("Summarize this person.", { type: "object" });
    expect(a).not.toBe(b);
    expect(a2).toBe(a);
  });

  it("changes when the response schema changes, with the prompt untouched", () => {
    const a = promptRevision("same prompt", { required: ["summary"] });
    const b = promptRevision("same prompt", { required: ["summary", "tone"] });
    expect(a).not.toBe(b);
  });
});

/**
 * Each of these reconstructs the key the PRE-FIX code computed and asserts the
 * current key differs. That is the property that matters and the one that was
 * missing: the artifact a stale prompt produced must no longer be found. It also
 * needs no maintenance when a prompt is edited, unlike a pinned digest.
 */
describe("every content-addressed artifact now carries its prompt fingerprint", () => {
  const sha = (canonical: string) => sha256Hex(utf8ToBytes(canonical));

  it("ai_profile: no longer keyed by the hand-written \"ai_profile.v1\"", () => {
    const inputs = { transcripts: ["hi"], profile, nostrSummary: "", lang: "en" };
    const before = sha(
      JSON.stringify({
        t: inputs.transcripts,
        p: inputs.profile,
        n: "",
        lang: "en",
        m: "venice:m",
        schema: "ai_profile.v1",
      }),
    );
    expect(profileInputsHash(inputs, "venice:m")).not.toBe(before);
  });

  it("translation: no longer keyed by the hand-written \"profile_translation.v1\"", () => {
    const f = { about: "hola", looking_for: "un diseñador", skills: ["zk"] };
    const before = sha(
      JSON.stringify({
        about: f.about,
        looking_for: f.looking_for,
        skills: f.skills,
        lang: "en",
        m: "venice:m",
        schema: "profile_translation.v1",
      }),
    );
    expect(translationInputsHash(f, "en", "venice:m")).not.toBe(before);
  });

  it("nostr_summary: had NO prompt field at all, and now has one", () => {
    const posts = [{ kind: 1, content: "gm", created_at: 1 }];
    const before = sha(
      JSON.stringify({
        pubkey: "pk",
        lang: "en",
        ids: ["1:1:gm"],
        m: "venice:m",
      }),
    );
    expect(nostrInputsHash("pk", posts, "en", "venice:m")).not.toBe(before);
  });

  it("all three are still stable for identical inputs (the cache still works)", () => {
    const inputs = { transcripts: ["hi"], profile, lang: "en" };
    expect(profileInputsHash(inputs, "m")).toBe(profileInputsHash(inputs, "m"));
    const f = { about: "hola", looking_for: "x", skills: ["zk"] };
    expect(translationInputsHash(f, "en", "m")).toBe(translationInputsHash(f, "en", "m"));
    const posts = [{ kind: 1, content: "gm", created_at: 1 }];
    expect(nostrInputsHash("pk", posts, "en", "m")).toBe(nostrInputsHash("pk", posts, "en", "m"));
  });
});

describe("pairInputsHash (audit PIPE-3)", () => {
  it("is order-independent in the pair, as before", () => {
    expect(pairInputsHash("h1", "h2", "m")).toBe(pairInputsHash("h2", "h1", "m"));
  });

  it("CHANGES when the scoring model changes", () => {
    // The core of the finding: switching the `match` role to another model used to
    // leave every cached pair score in place, so the switch cost nothing and did
    // nothing.
    expect(pairInputsHash("h1", "h2", "venice:llama")).not.toBe(
      pairInputsHash("h1", "h2", "venice:qwen"),
    );
  });

  it("carries the matching prompt's fingerprint — the pre-fix key is gone", () => {
    const rev = matchPromptRevision();
    expect(rev).toMatch(/^[0-9a-f]{12}$/);
    // Exactly what the two-argument version computed.
    const before = sha256Hex(utf8ToBytes("h1|h2"));
    expect(pairInputsHash("h1", "h2", "m")).not.toBe(before);
  });

  it("still distinguishes the attendees themselves", () => {
    expect(pairInputsHash("h1", "h2", "m")).not.toBe(pairInputsHash("h1", "h3", "m"));
  });
});
