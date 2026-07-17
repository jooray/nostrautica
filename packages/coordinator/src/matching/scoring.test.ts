import { describe, it, expect } from "vitest";
import type { AiProfile } from "@nostrautica/protocol";
import { MockLlm } from "../providers/mock.js";
import {
  scoreBatch,
  scoreReverseBatch,
  languageInstruction,
  BATCH_SYSTEM_PROMPT,
  REVERSE_BATCH_SYSTEM_PROMPT,
  BATCH_SCORE_SCHEMA,
  type BatchCandidate,
  type EventContextForScoring,
} from "./scoring.js";

const EVENT: EventContextForScoring = {
  title: "Cypherpunk Assembly",
  summary: "Freedom tech builders meetup",
  hashtags: ["cypherpunk", "privacy"],
  lang: "en",
};

function profile(name: string): AiProfile {
  return {
    summary: `${name} summary`,
    skills: [`${name}-skill`],
    interests: [`${name}-interest`],
    offers: [`${name}-offer`],
    seeks: [`${name}-seek`],
  };
}

function candidates(n: number): BatchCandidate[] {
  return Array.from({ length: n }, (_, i) => ({ id: `cand${i}`, profile: profile(`cand${i}`) }));
}

/** Mock that scores every listed candidate; reasoning names the candidate it saw. */
function echoLlm(): MockLlm {
  return new MockLlm((req) => {
    const matches = [];
    for (const m of req.user.matchAll(/--- CANDIDATE (\d+) ---\nSummary: (\S+) summary/g)) {
      matches.push({
        index: Number(m[1]),
        similarity: 0.4,
        complementarity: 0.8,
        score: 0.7,
        reasoning_for_target: `You should meet ${m[2]} — talk shop.`,
      });
    }
    return { matches };
  });
}

describe("batched scoring (spec §9.3/§16.2, BP3)", () => {
  it("system prompt is BP3: rubric anchors + host-voice reasoning instructions", () => {
    // Rubric anchors (score bands) — the benchmark's biggest separation win.
    expect(BATCH_SYSTEM_PROMPT).toContain("0.9-1.0 = a near-perfect mutual fit");
    expect(BATCH_SYSTEM_PROMPT).toContain("0.0-0.1 = no real reason to meet");
    expect(BATCH_SYSTEM_PROMPT).toContain("most candidates in\n   a batch should NOT score high");
    // Host-voice block — user-facing reasoning, no analytical framing.
    expect(BATCH_SYSTEM_PROMPT).toContain("THIS TEXT IS SHOWN DIRECTLY TO THE TARGET ATTENDEE");
    expect(BATCH_SYSTEM_PROMPT).toContain("voice of a good host");
    expect(BATCH_SYSTEM_PROMPT).toContain("ABSOLUTELY NO analytical framing");
    // Independence + grounding rules.
    expect(BATCH_SYSTEM_PROMPT).toContain("Score each candidate INDEPENDENTLY");
    expect(BATCH_SYSTEM_PROMPT).toContain("Never invent skills, goals, or facts");
    // Strict schema shape matches the benchmark harness.
    expect((BATCH_SCORE_SCHEMA.properties.matches.items.required as readonly string[])).toContain(
      "reasoning_for_target",
    );
  });

  it("user prompt carries the 31923 event context, target, and numbered candidates", async () => {
    let seen: { system: string; user: string } | undefined;
    const llm = new MockLlm((req) => {
      seen = req;
      return { matches: [] };
    });
    await scoreBatch(llm, "m", EVENT, profile("target"), candidates(3));
    expect(seen!.system).toBe(BATCH_SYSTEM_PROMPT);
    expect(seen!.user).toContain("EVENT: Cypherpunk Assembly");
    expect(seen!.user).toContain("ABOUT: Freedom tech builders meetup");
    expect(seen!.user).toContain("TOPICS: cypherpunk, privacy");
    expect(seen!.user).toContain("TARGET ATTENDEE:");
    expect(seen!.user).toContain("Summary: target summary");
    for (const i of [1, 2, 3]) expect(seen!.user).toContain(`--- CANDIDATE ${i} ---`);
  });

  it("maps indices back through the shuffled candidate order", async () => {
    const cands = candidates(5);
    // Reversing rng: shuffle becomes a deterministic permutation ≠ identity.
    const { scores, missing } = await scoreBatch(echoLlm(), "m", EVENT, profile("t"), cands, () => 0);
    expect(missing).toEqual([]);
    for (const c of cands) {
      // Whatever position the candidate ended up at, its result maps back to it.
      expect(scores.get(c.id)!.reasoning).toContain(`You should meet ${c.id}`);
    }
  });

  it("clamps and rescales scores to [0,1] (0-10 / 0-100 scales, out-of-range)", async () => {
    const llm = new MockLlm(() => ({
      matches: [
        { index: 1, similarity: 8, complementarity: 85, score: 9, reasoning_for_target: "You should say hi." },
        { index: 2, similarity: -0.5, complementarity: 1.0, score: 2, reasoning_for_target: "You too." },
      ],
    }));
    const cands = candidates(2);
    const { scores } = await scoreBatch(llm, "m", EVENT, profile("t"), cands, () => 0.999999);
    // rng ~1 keeps Fisher–Yates order identical → index 1 = cand0, 2 = cand1.
    const s1 = scores.get("cand0")!;
    expect(s1.score).toBeCloseTo(0.9);
    expect(s1.similarity).toBeCloseTo(0.8);
    expect(s1.complementarity).toBeCloseTo(0.85);
    const s2 = scores.get("cand1")!;
    expect(s2.similarity).toBe(0);
    expect(s2.score).toBeCloseTo(0.2);
  });

  it("partial batch failure: missing/malformed/duplicate entries never poison the rest", async () => {
    const llm = new MockLlm(() => ({
      matches: [
        { index: 1, similarity: 0.5, complementarity: 0.5, score: 0.5, reasoning_for_target: "You: meet one." },
        // duplicate index — must be ignored, not overwrite
        { index: 1, similarity: 0, complementarity: 0, score: 0, reasoning_for_target: "dup" },
        // malformed: empty reasoning
        { index: 2, similarity: 0.5, complementarity: 0.5, score: 0.5, reasoning_for_target: "" },
        // out of range index
        { index: 99, similarity: 0.5, complementarity: 0.5, score: 0.5, reasoning_for_target: "ghost" },
        // index 3 simply missing
        { index: 4, similarity: 0.6, complementarity: 0.6, score: 0.6, reasoning_for_target: "You: meet four." },
      ],
    }));
    const cands = candidates(4);
    const { scores, missing } = await scoreBatch(llm, "m", EVENT, profile("t"), cands, () => 0.999999);
    expect(scores.get("cand0")!.reasoning).toBe("You: meet one."); // duplicate ignored
    expect(scores.get("cand3")!.score).toBeCloseTo(0.6);
    expect(missing.sort()).toEqual(["cand1", "cand2"]); // empty reasoning + absent
  });

  it("empty candidate list short-circuits without an LLM call", async () => {
    const llm = echoLlm();
    const { scores, missing } = await scoreBatch(llm, "m", EVENT, profile("t"), []);
    expect(scores.size).toBe(0);
    expect(missing).toEqual([]);
    expect(llm.completeCalls).toBe(0);
  });
});

describe("per-event output language (spec §7.1/§9.3)", () => {
  it("en events get NO language instruction (BP3 unchanged, no default-en phrasing)", () => {
    expect(languageInstruction("en")).toBe("");
    expect(languageInstruction("EN")).toBe("");
    expect(BATCH_SYSTEM_PROMPT).not.toContain("OUTPUT LANGUAGE");
  });

  it("a non-en event appends an explicit output-language instruction to the prompt", async () => {
    let seen: { system: string } | undefined;
    const llm = new MockLlm((req) => {
      seen = req;
      return { matches: [] };
    });
    await scoreBatch(llm, "m", { ...EVENT, lang: "sk" }, profile("t"), candidates(2));
    // BP3 stays verbatim, the language block is appended.
    expect(seen!.system).toContain(BATCH_SYSTEM_PROMPT);
    expect(seen!.system).toContain("OUTPUT LANGUAGE:");
    expect(seen!.system).toContain("write every");
    expect(seen!.system).toContain("Slovak (sk)");
    // Never assumes the input language.
    expect(seen!.system).toContain("may be written in any language");
  });

  it("names the language from its ISO code (e.g. cs → Czech)", () => {
    expect(languageInstruction("cs")).toContain("Czech (cs)");
  });
});

describe("reverse batched scoring (spec §16.2 reverse variant)", () => {
  /** Mock scoring K targets against one shared person; reasoning names the target. */
  function reverseEchoLlm(): MockLlm {
    return new MockLlm((req) => {
      const matches = [];
      for (const m of req.user.matchAll(/--- TARGET (\d+) ---\nSummary: (\S+) summary/g)) {
        matches.push({
          index: Number(m[1]),
          similarity: 0.4,
          complementarity: 0.8,
          score: 0.7,
          reasoning_for_target: `You should meet the shared person, ${m[2]}.`,
        });
      }
      return { matches };
    });
  }

  it("uses the mirror BP3 prompt (shared candidate + K targets), same anchors/voice", () => {
    expect(REVERSE_BATCH_SYSTEM_PROMPT).toContain("0.9-1.0 = a near-perfect mutual fit");
    expect(REVERSE_BATCH_SYSTEM_PROMPT).toContain("THIS TEXT IS SHOWN DIRECTLY TO THE TARGET ATTENDEE");
    expect(REVERSE_BATCH_SYSTEM_PROMPT).toContain("ABSOLUTELY NO analytical framing");
    expect(REVERSE_BATCH_SYSTEM_PROMPT).toContain("ONE shared person");
  });

  it("scores every target against the shared person and maps indices back", async () => {
    const targets = candidates(4);
    const { scores, missing } = await scoreReverseBatch(
      reverseEchoLlm(),
      "m",
      EVENT,
      profile("shared"),
      targets,
      () => 0,
    );
    expect(missing).toEqual([]);
    for (const t of targets) {
      expect(scores.get(t.id)!.reasoning).toContain(`meet the shared person, ${t.id}`);
    }
  });

  it("carries the shared-person block + numbered targets, and the language block", async () => {
    let seen: { system: string; user: string } | undefined;
    const llm = new MockLlm((req) => {
      seen = req;
      return { matches: [] };
    });
    await scoreReverseBatch(llm, "m", { ...EVENT, lang: "sk" }, profile("shared"), candidates(2));
    expect(seen!.user).toContain("SHARED PERSON");
    expect(seen!.user).toContain("Summary: shared summary");
    expect(seen!.user).toContain("--- TARGET 1 ---");
    expect(seen!.system).toContain("Slovak (sk)");
  });

  it("empty target list short-circuits without an LLM call", async () => {
    const llm = reverseEchoLlm();
    const { scores } = await scoreReverseBatch(llm, "m", EVENT, profile("s"), []);
    expect(scores.size).toBe(0);
    expect(llm.completeCalls).toBe(0);
  });
});

describe("name-aware reasoning (B1, TEST-REPORT-2026-07-16-MATCHING)", () => {
  it("forward batch carries Name: lines for the target and named candidates", async () => {
    let seen: { user: string } | undefined;
    const llm = new MockLlm((req) => {
      seen = req;
      return { matches: [] };
    });
    const cands = [{ id: "c1", profile: profile("c1"), name: "Priya Chandrasekaran" }];
    await scoreBatch(llm, "m", EVENT, profile("t"), cands, Math.random, "Marek Dvořák");
    expect(seen!.user).toContain("TARGET ATTENDEE:\nName: Marek Dvořák");
    expect(seen!.user).toContain("--- CANDIDATE 1 ---\nName: Priya Chandrasekaran");
  });

  it("reverse batch carries Name: lines for the shared person and targets", async () => {
    let seen: { user: string } | undefined;
    const llm = new MockLlm((req) => {
      seen = req;
      return { matches: [] };
    });
    const targets = [{ id: "t1", profile: profile("t1"), name: "Tomás Herrera" }];
    await scoreReverseBatch(llm, "m", EVENT, profile("s"), targets, Math.random, "Sofia Lindqvist");
    expect(seen!.user).toContain("SHARED PERSON (the one each target below would meet):\nName: Sofia Lindqvist");
    expect(seen!.user).toContain("--- TARGET 1 ---\nName: Tomás Herrera");
  });

  it("a nameless profile omits the Name line (pre-migration rows degrade gracefully)", async () => {
    let seen: { user: string } | undefined;
    const llm = new MockLlm((req) => {
      seen = req;
      return { matches: [] };
    });
    await scoreBatch(llm, "m", EVENT, profile("t"), candidates(1));
    expect(seen!.user).not.toContain("Name:");
  });

  it("both prompts forbid reusing example names and pin the 'you' binding", () => {
    expect(BATCH_SYSTEM_PROMPT).toContain("never a");
    expect(BATCH_SYSTEM_PROMPT).toContain('example names, not attendees');
    expect(BATCH_SYSTEM_PROMPT).toContain('The TARGET is always "you"');
    expect(REVERSE_BATCH_SYSTEM_PROMPT).toContain('Each TARGET is always "you" in their own entry');
    expect(REVERSE_BATCH_SYSTEM_PROMPT).toContain("an example name, not an attendee");
  });
});
