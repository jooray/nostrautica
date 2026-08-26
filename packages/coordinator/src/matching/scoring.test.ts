import { describe, it, expect } from "vitest";
import { hasAiProfileContent, type AiProfile } from "@nostrautica/protocol";
import { MockLlm } from "../providers/mock.js";
import {
  scoreBatch,
  scoreReverseBatch,
  hasProfileContent,
  languageInstruction,
  reverseSystemPrompt,
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

  it("icebreakers: capped at 3, empties dropped, absent stays undefined (NIP §6.2)", async () => {
    const llm = new MockLlm(() => ({
      matches: [
        {
          index: 1,
          similarity: 0.5,
          complementarity: 0.5,
          score: 0.7,
          reasoning_for_target: "You should meet.",
          icebreakers: ["a", "", "b".repeat(400), "c", "d"], // 4 non-empty + 1 empty
        },
        {
          index: 2,
          similarity: 0.5,
          complementarity: 0.5,
          score: 0.7,
          reasoning_for_target: "You too.",
          // no icebreakers field at all
        },
      ],
    }));
    const cands = candidates(2);
    const { scores } = await scoreBatch(llm, "m", EVENT, profile("t"), cands, () => 0);
    // One candidate (the entry WITH icebreakers) is capped at 3 with empties dropped;
    // the other (no icebreakers field) stays undefined — order is shuffled, so assert
    // across both rather than by position.
    const results = [...scores.values()];
    const withIb = results.find((r) => r.icebreakers);
    const withoutIb = results.find((r) => !r.icebreakers);
    expect(withIb!.icebreakers).toHaveLength(3);
    expect(withIb!.icebreakers!.every((s) => s.length > 0 && s.length <= 280)).toBe(true);
    expect(withoutIb!.icebreakers).toBeUndefined();
  });

  it("icebreakers: duplicates dropped before the cap, not after", async () => {
    // Clients key their {#each} on the icebreaker string, and a duplicate key is
    // a hard throw in Svelte 5 that kills the whole route — so a model repeating
    // itself (common when asked for three openers on one shared interest) must
    // not reach them. Deduping BEFORE the cap also means a repeat costs a slot
    // instead of the third distinct starter.
    const long = "x".repeat(400);
    const llm = new MockLlm(() => ({
      matches: [
        {
          index: 1,
          similarity: 0.5,
          complementarity: 0.5,
          score: 0.7,
          reasoning_for_target: "You should meet.",
          // "one" twice; the two long strings differ only past the 280-char clip
          // and so collide only AFTER truncation.
          icebreakers: ["one", "one", long + "A", long + "B", "two"],
        },
      ],
    }));
    const { scores } = await scoreBatch(llm, "m", EVENT, profile("t"), candidates(1), () => 0);
    const ib = [...scores.values()][0]!.icebreakers!;
    expect(new Set(ib).size).toBe(ib.length); // no duplicate keys reach the client
    expect(ib).toEqual(["one", long.slice(0, 280), "two"]);
  });

  it("both prompts pin the icebreaker speaker/listener and forbid swapping attribution", () => {
    // The two text fields invert the pronoun: in reasoning_for_target "you" is
    // the reader, in an icebreaker "you" is the person they are messaging (the
    // app pastes icebreakers[0] straight into a DM to them). Prod 2026-07-24: the
    // model credited the reader's own novel, app and code to the OTHER person
    // ("your novel Tamers of Entropy" sent to someone who did not write it), and
    // wrote third-party briefings ("You're a cypherpunk — she studies X") that
    // cannot be sent as a message at all. Both prompts must state the binding.
    for (const p of [BATCH_SYSTEM_PROMPT, REVERSE_BATCH_SYSTEM_PROMPT]) {
      expect(p).toContain("WHO IS WHO");
      expect(p).toContain('"I"/"my"'); // the reader speaks in the first person
      expect(p).toContain("Never hand one person's work to the other");
      expect(p).toContain("Write a message, not a briefing");
      // Named ROLES, not just pronouns. Prod 2026-07-25 (Slovak) swapped the two
      // people wholesale — the reader was written as the candidate's profession
      // and handed their own app — so the binding must survive translation into a
      // language whose possessives are nothing like "my"/"your".
      expect(p).toContain("SENDER");
      expect(p).toContain("RECIPIENT");
      expect(p).toContain("they never swap");
      expect(p).toContain("It holds in whatever language you");
      // A shared artifact (the candidate's bio led with the target's book, whose
      // cover they drew) is ambiguous from the text alone, so provenance is
      // asserted from the BLOCK a thing appears in, not from the wording.
      expect(p).toContain("WHOSE IS IT, when both profiles name the same thing");
      expect(p).toContain("A mention does NOT transfer authorship");
      // "INVERTS the field above" was itself a hazard: read as licence to swap the
      // people, not just the pronouns. It must not come back.
      expect(p).not.toContain("INVERTS the field above");
    }
  });

  it("the user block asserts provenance and labels the two roles (prod 2026-07-25)", async () => {
    let seen: { user: string } | undefined;
    const llm = new MockLlm((req) => {
      seen = req;
      return { matches: [] };
    });
    await scoreBatch(llm, "m", EVENT, profile("t"), candidates(2));
    // A mention in the candidate's own profile must not read as authorship.
    expect(seen!.user).toContain("may mention something the TARGET made");
    expect(seen!.user).toContain("never makes it theirs");
    // Roles labelled next to the data they bind.
    expect(seen!.user).toContain("is the SENDER of every icebreaker below");
    expect(seen!.user).toContain("is the RECIPIENT of the icebreakers in their own entry");
    // Delimiters unchanged: scoring.test.ts's echo mock, matcher.ts and the
    // benchmark harness all parse them.
    expect(seen!.user).toContain("TARGET ATTENDEE:\nSummary: t summary");
    expect(seen!.user).toContain("--- CANDIDATE 1 ---\nSummary: ");
  });

  it("the scoring schema + prompt include icebreakers (NIP §6.2)", () => {
    expect("icebreakers" in BATCH_SCORE_SCHEMA.properties.matches.items.properties).toBe(true);
    expect(BATCH_SYSTEM_PROMPT).toContain("icebreakers");
    expect(REVERSE_BATCH_SYSTEM_PROMPT).toContain("icebreakers");
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

// prod 2026-07-31: an organizer's match list showed each person's card carrying the
// NEXT person's match text — cotsoor's write-up under Ľudo's name and avatar, and so
// on down the list. Nothing in the pipeline had corrupted anything: `index` is the
// only thing tying an LLM-authored reasoning to a pubkey, and an index put on the
// wrong block parses perfectly, so the batch logged "10 scored, 0 unparsed" while
// every attendee was being described to the wrong person.
describe("a batch entry has to agree about who it is about", () => {
  /** Candidates with real display names, which is what makes the echo checkable. */
  function named(...names: string[]): BatchCandidate[] {
    return names.map((n) => ({ id: `id-${n}`, profile: profile(n), name: n }));
  }

  it("repairs an entry whose number and name point at different people", async () => {
    // The reported shape: the text is about cotsoor, the number says Ľudo.
    const llm = new MockLlm(() => ({
      matches: [
        {
          index: 1,
          entry_name: "cotsoor",
          similarity: 0.5,
          complementarity: 0.9,
          score: 0.9,
          reasoning_for_target: "Cotsoor runs the Bratislava meetups and you run Brno's.",
        },
      ],
    }));
    // 0.999999 leaves the shuffle at identity order, so index 1 really is Ludo.
    const cands = named("Ludo", "cotsoor");
    const { scores, missing, misattributed } = await scoreBatch(
      llm, "m", EVENT, profile("t"), cands, () => 0.999999,
    );
    // The write-up lands on cotsoor, who it is actually about — not on Ludo.
    expect(scores.get("id-cotsoor")!.reasoning).toContain("Cotsoor runs");
    expect(scores.has("id-Ludo")).toBe(false);
    expect(missing).toEqual(["id-Ludo"]); // re-scored rather than given someone else's text
    expect(misattributed![0]).toContain("cotsoor");
  });

  it("matches the echoed name past diacritics and casing", async () => {
    // We print "Ľudo"; a model that copies it back as "ludo" has not made a mistake,
    // and discarding a good score over an accent would be its own bug.
    const llm = new MockLlm(() => ({
      matches: [
        {
          index: 1,
          entry_name: "  ĽUDO ",
          similarity: 0.5,
          complementarity: 0.5,
          score: 0.5,
          reasoning_for_target: "You two should talk.",
        },
      ],
    }));
    const { scores, misattributed } = await scoreBatch(
      llm, "m", EVENT, profile("t"), named("Ľudo"), () => 0,
    );
    expect(scores.get("id-Ľudo")!.reasoning).toBe("You two should talk.");
    expect(misattributed).toBeUndefined();
  });

  it("drops an entry naming nobody in the batch instead of guessing", async () => {
    const llm = new MockLlm(() => ({
      matches: [
        {
          index: 1,
          entry_name: "Someone Else Entirely",
          similarity: 0.5,
          complementarity: 0.5,
          score: 0.5,
          reasoning_for_target: "About a person who isn't here.",
        },
      ],
    }));
    const { scores, missing, misattributed } = await scoreBatch(
      llm, "m", EVENT, profile("t"), named("Ludo"), () => 0,
    );
    expect(scores.size).toBe(0);
    expect(missing).toEqual(["id-Ludo"]);
    expect(misattributed![0]).toContain("dropped");
  });

  it("drops rather than picks when two people in the batch share the name", async () => {
    const llm = new MockLlm(() => ({
      matches: [
        {
          // Numbered as Ludo, but the echo says "Jan" — and two people are Jan.
          index: 3,
          entry_name: "Jan",
          similarity: 0.5,
          complementarity: 0.5,
          score: 0.5,
          reasoning_for_target: "Which Jan?",
        },
      ],
    }));
    // Two attendees called Jan: the echo cannot disambiguate, so it must not try.
    const cands: BatchCandidate[] = [
      { id: "jan-a", profile: profile("a"), name: "Jan" },
      { id: "jan-b", profile: profile("b"), name: "Jan" },
      { id: "other", profile: profile("o"), name: "Ludo" },
    ];
    const { scores, misattributed } = await scoreBatch(
      llm, "m", EVENT, profile("t"), cands, () => 0.999999,
    );
    expect(scores.has("other")).toBe(false);
    expect(misattributed![0]).toContain("dropped");
  });

  it("never lets two entries claim the same person", async () => {
    const llm = new MockLlm(() => ({
      matches: [
        {
          index: 1, entry_name: "cotsoor", similarity: 0.9, complementarity: 0.9, score: 0.9,
          reasoning_for_target: "The real one.",
        },
        // A second entry that also resolves onto cotsoor must not overwrite the first.
        {
          index: 2, entry_name: "cotsoor", similarity: 0.1, complementarity: 0.1, score: 0.1,
          reasoning_for_target: "The duplicate.",
        },
      ],
    }));
    const { scores } = await scoreBatch(
      llm, "m", EVENT, profile("t"), named("Ludo", "cotsoor"), () => 0.999999,
    );
    expect(scores.get("id-cotsoor")!.reasoning).toBe("The real one.");
    expect(scores.size).toBe(1);
  });

  it("still scores normally when the batch has no display names to check against", async () => {
    // Pre-migration attendees have no name: there is nothing to verify, and that
    // must not become a reason to drop every entry.
    const llm = new MockLlm(() => ({
      matches: [
        { index: 1, similarity: 0.5, complementarity: 0.5, score: 0.5, reasoning_for_target: "Go say hi." },
      ],
    }));
    const { scores, misattributed } = await scoreBatch(
      llm, "m", EVENT, profile("t"), candidates(1), () => 0,
    );
    expect(scores.get("cand0")!.reasoning).toBe("Go say hi.");
    expect(misattributed).toBeUndefined();
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

  it("the language block covers icebreakers and re-binds the roles in that language", () => {
    // Prod 2026-07-25: a Slovak event got the ownership RIGHT in
    // reasoning_for_target and inverted it in the icebreakers of the same entry.
    // WHO IS WHO can only name English pronouns; this block is the one place that
    // knows the output language, and it lands last in the system prompt.
    const sk = languageInstruction("sk");
    expect(sk).toContain("every icebreaker in Slovak (sk)");
    expect(sk).toContain("Translating moves no ownership");
    expect(sk).toContain("Slovak's FIRST-person possessive forms");
    expect(sk).toContain("still mean the SENDER");
    expect(sk).toContain("Slovak's SECOND-person possessive forms still mean the RECIPIENT");
    expect(sk).toContain("never attach a second-person");
  });

  it("names the language from its ISO code (e.g. cs → Czech)", () => {
    expect(languageInstruction("cs")).toContain("Czech (cs)");
    expect(languageInstruction("cs")).toContain("Czech's FIRST-person possessive forms");
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
    // Same provenance + role labelling as the forward shape, roles mirrored: here
    // the shared person is the RECIPIENT and each target a SENDER.
    expect(seen!.user).toContain("may mention something a TARGET made");
    expect(seen!.user).toContain("never makes it theirs");
    expect(seen!.user).toContain("is the RECIPIENT of every icebreaker below");
    expect(seen!.user).toContain("is the SENDER of the icebreakers in their own entry");
  });

  it("empty target list short-circuits without an LLM call", async () => {
    const llm = reverseEchoLlm();
    const { scores } = await scoreReverseBatch(llm, "m", EVENT, profile("s"), []);
    expect(scores.size).toBe(0);
    expect(llm.completeCalls).toBe(0);
  });

  // ── the 2026-07-25 restructure ──────────────────────────────────────────────
  // The forward shape scores 0 attribution errors in en and sk; this one does not,
  // and the prompts say the same things. The difference is that this shape prints
  // the RECIPIENT first under a heading and leaves each SENDER as item n of a list.
  // These tests pin the two devices that push the senders back up: a writer
  // directory above the shared person, and a per-entry binding line under every
  // target. Reword them freely — but a version of this block where a sender is
  // named nowhere except inside a numbered list is the version that shipped the bug.
  it("names every writer ABOVE the shared person's block, writer first", async () => {
    let seen: { user: string } | undefined;
    const llm = new MockLlm((req) => {
      seen = req;
      return { matches: [] };
    });
    const targets = [
      { id: "t1", profile: profile("t1"), name: "Marek Hraško" },
      { id: "t2", profile: profile("t2"), name: "Jana Kováčová" },
    ];
    await scoreReverseBatch(llm, "m", EVENT, profile("s"), targets, () => 0, "Pavol Nemec");
    // Sliced against the shared person's HEADING, not the first "SHARED PERSON" —
    // the ownership preamble names it several lines earlier.
    const directory = seen!.user.slice(
      seen!.user.indexOf("WHO WRITES EACH ENTRY"),
      seen!.user.indexOf("SHARED PERSON (the one"),
    );
    // Load-bearing: the directory is ABOVE the shared person's heading, or it is
    // just more text after the block that already won the protagonist slot. Read
    // back against the numbered blocks (the list is shuffled) — a directory whose
    // numbering disagreed with the blocks would be worse than none.
    for (const n of [1, 2]) {
      const name = seen!.user.match(new RegExp(`--- TARGET ${n} ---\\nName: (.+)`))![1];
      expect(directory).toContain(`entry ${n}: ${name} (TARGET ${n} below) writes to Pavol Nemec`);
    }
    expect(directory).toContain("being printed first does not make them the writer");
  });

  it("binds the writer again inside every numbered entry", async () => {
    let seen: { user: string } | undefined;
    const llm = new MockLlm((req) => {
      seen = req;
      return { matches: [] };
    });
    await scoreReverseBatch(llm, "m", EVENT, profile("s"), candidates(3), () => 0, "Sofia");
    for (const n of [1, 2, 3]) {
      expect(seen!.user).toContain(`(Entry ${n} is written BY the TARGET ${n} profile above, TO Sofia:`);
    }
    // The binding follows its own profile, so it cannot be read as belonging to the
    // next target: the line for entry 1 sits before the "--- TARGET 2 ---" heading.
    const e1 = seen!.user.indexOf("(Entry 1 is written BY");
    expect(e1).toBeGreaterThan(seen!.user.indexOf("--- TARGET 1 ---"));
    expect(e1).toBeLessThan(seen!.user.indexOf("--- TARGET 2 ---"));
  });

  it("nameless targets degrade to positional labels, never to 'undefined'", async () => {
    let seen: { user: string } | undefined;
    const llm = new MockLlm((req) => {
      seen = req;
      return { matches: [] };
    });
    await scoreReverseBatch(llm, "m", EVENT, profile("s"), candidates(2), () => 0);
    expect(seen!.user).toContain("entry 1: TARGET 1 (TARGET 1 below) writes to the shared person");
    expect(seen!.user).not.toContain("undefined");
  });

  it("keeps the three landmarks coordinator.test.ts's fake LLM slices on", async () => {
    // That fake reads the user block to decide who it was asked to score: it splits
    // on the SHARED PERSON heading, then on TARGET ATTENDEES:, then on the TARGET
    // delimiters. A restructure that reorders those, or prints TARGET ATTENDEES:
    // twice, silently makes it answer about the wrong people — which no assertion
    // in that file spells out, so it is asserted here instead.
    let seen: { user: string } | undefined;
    const llm = new MockLlm((req) => {
      seen = req;
      return { matches: [] };
    });
    await scoreReverseBatch(llm, "m", EVENT, profile("shared"), candidates(2), () => 0);
    const u = seen!.user;
    expect(u).toContain("SHARED PERSON (the one each target below would meet):\nSummary: shared summary");
    expect(u.split("TARGET ATTENDEES:")).toHaveLength(2);
    expect(u.indexOf("SHARED PERSON (")).toBeLessThan(u.indexOf("TARGET ATTENDEES:"));
    expect(u.indexOf("TARGET ATTENDEES:")).toBeLessThan(u.indexOf("--- TARGET 1 ---"));
    // Order is shuffled (rng 0 reverses), so match the shape, not a given target.
    expect(u).toMatch(/--- TARGET 1 ---\nSummary: cand\d summary/);
    // The shared block the fake extracts must hold the shared profile and nothing
    // from any target: it is everything between the two headings.
    const sharedBlock = u.slice(u.indexOf("SHARED PERSON ("), u.indexOf("TARGET ATTENDEES:"));
    expect(sharedBlock).not.toContain("cand0");
  });

  it("tells the model that print order is not role order", () => {
    // The deployed prompt already said the target is the sender, in these same
    // words, and production inverted it anyway. This is the only line that names
    // the suspected cause — the recipient being printed first — and overrules it.
    expect(REVERSE_BATCH_SYSTEM_PROMPT).toContain("BLOCK ORDER IS NOT ROLE ORDER");
    expect(REVERSE_BATCH_SYSTEM_PROMPT).toContain("Printed first does not mean speaking");
    expect(REVERSE_BATCH_SYSTEM_PROMPT).toContain("the line is right");
    // The forward shape prints its SENDER first and does not have this problem, so
    // it must NOT carry the rule — the forward prompt is benchmark-clean as it is.
    expect(BATCH_SYSTEM_PROMPT).not.toContain("BLOCK ORDER IS NOT ROLE ORDER");
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

describe("hasProfileContent — the guard against scoring nothing", () => {
  it("is the protocol's shared notion of empty, so app and coordinator cannot drift", () => {
    expect(hasProfileContent).toBe(hasAiProfileContent);
  });

  it("rejects the empty-input profile the pipeline publishes (audit COORD-4 skip)", () => {
    expect(hasProfileContent({ summary: "", skills: [], interests: [], offers: [], seeks: [] })).toBe(false);
  });

  it("accepts a profile carrying ANY one field — a single skill is still signal", () => {
    const empty = { summary: "", skills: [], interests: [], offers: [], seeks: [] };
    expect(hasProfileContent({ ...empty, skills: ["mesh networking"] })).toBe(true);
  });
});

/**
 * Reverse-batch output language (2026-08-26).
 *
 * The trailing OUTPUT LANGUAGE block already names icebreakers explicitly, and
 * deepseek-v4-flash-0731 ignores it for a whole response about one call in ten:
 * 15 of 144 Slovak reverse batches returned all thirty openers in English, never
 * a partial one. Repeating the requirement inside the icebreaker block — the
 * placement benchmarks/matching measured as L2 — took that to 1 of 96,
 * Fisher exact p = 0.0032, with attribution unchanged.
 *
 * These pin the splice rather than the effect: the effect lives in the benchmark,
 * but a reworded prompt that silently dropped the reminder would revert it with
 * nothing failing, which is how the original regression shipped.
 */
describe("reverseSystemPrompt — the language reminder is inside the icebreaker block", () => {
  it("adds nothing for an English event", () => {
    expect(reverseSystemPrompt("en")).toBe(REVERSE_BATCH_SYSTEM_PROMPT + languageInstruction("en"));
  });

  it("names the event language in the reminder, for each language we ship", () => {
    for (const [lang, name] of [["sk", "Slovak"], ["cs", "Czech"], ["de", "German"]] as const) {
      const p = reverseSystemPrompt(lang);
      expect(p).toContain(`Every icebreaker above must be written in ${name} (${lang})`);
    }
  });

  it("places it BEFORE the 'Return one entry per target' instruction, not at the end", () => {
    // Placement is the entire finding. Hoisting the requirement to the top of the
    // prompt measured WORSE than the control (33% vs 19% of calls fully English);
    // only this position helped. A reminder appended after the closing
    // instruction would be a different, unmeasured prompt.
    const p = reverseSystemPrompt("sk");
    expect(p.indexOf("Every icebreaker above must be written in Slovak")).toBeLessThan(
      p.indexOf("Return one entry per target"),
    );
  });

  it("still ends with the trailing OUTPUT LANGUAGE block — the reminder adds to it, not replaces it", () => {
    const p = reverseSystemPrompt("sk");
    expect(p.endsWith(languageInstruction("sk"))).toBe(true);
    expect(p).toContain("OUTPUT LANGUAGE:");
  });

  it("changes the prompt by exactly one sentence", () => {
    const p = reverseSystemPrompt("sk");
    const baseline = REVERSE_BATCH_SYSTEM_PROMPT + languageInstruction("sk");
    expect(p).not.toBe(baseline);
    expect(p.length - baseline.length).toBeLessThan(140);
  });

  it("throws rather than silently shipping the un-reminded prompt if the anchor moves", async () => {
    // The failure this guards against is a reworded icebreaker block quietly
    // reverting a measured fix, which is exactly how the regression it fixes got in.
    const mod = await import("./scoring.js");
    expect(mod.REVERSE_BATCH_SYSTEM_PROMPT).toContain("Return one entry per target");
  });
});
