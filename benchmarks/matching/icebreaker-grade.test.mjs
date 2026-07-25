/**
 * The grader has to be right before its numbers mean anything, so it is pinned
 * against the ACTUAL production failures reported on 2026-07-24 (translated from
 * the Slovak originals, structure preserved) plus the shapes that must NOT be
 * flagged. Run: node --test benchmarks/matching/icebreaker-grade.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { attributionOf, isBriefing, gradeIcebreaker, summarize } from "./icebreaker-grade.mjs";

const target = {
  firstName: "Juraj",
  signature: { entity: "Tamers of Entropy", kind: "novel", verb: "wrote" },
};
const candidate = {
  firstName: "Marianna",
  signature: { entity: "Kestrel Mesh", kind: "mesh-network stack", verb: "maintains" },
};

test("attributionOf reads the nearest possessive", () => {
  assert.equal(attributionOf("Can your book Tamers of Entropy get a rebrand?", "Tamers of Entropy"), "second");
  assert.equal(attributionOf("I'm the one who wrote my novel Tamers of Entropy", "Tamers of Entropy"), "first");
  assert.equal(attributionOf("Nothing here mentions it", "Tamers of Entropy"), "none");
  // An earlier "I" must not beat a nearer "your".
  assert.equal(attributionOf("I really enjoyed your Kestrel Mesh work", "Kestrel Mesh"), "second");
  // ...and vice versa.
  assert.equal(attributionOf("You might like my Tamers of Entropy", "Tamers of Entropy"), "first");
  assert.equal(attributionOf("Is Kestrel Mesh yours?", "Kestrel Mesh"), "second");
});

test("THEFT: the reader's own novel handed to the person they are messaging", () => {
  // The exact prod failure. Juraj wrote it; this is addressed TO Marianna.
  const bad = "Can your book Tamers of Entropy get a new brand? I'd love to take a look.";
  assert.deepEqual(gradeIcebreaker(bad, target, candidate), ["THEFT"]);
});

test("FALSE_CLAIM: the reader claims the other person's work", () => {
  const bad = "I've been building my Kestrel Mesh for a while — want to compare notes?";
  assert.deepEqual(gradeIcebreaker(bad, target, candidate), ["FALSE_CLAIM"]);
});

test("BRIEFING: third-party framing that cannot be sent as a message", () => {
  // Prod: "You're a cypherpunk exploring consciousness — Psychiatric Ward studies
  // mental health as a system to hack." Same shape, with the name third-person.
  assert.equal(isBriefing("Marianna maintains a mesh stack — ask her about it.", "Marianna"), true);
  assert.equal(isBriefing("You should grab her and ask her about the roadmap.", "Marianna"), true);
});

test("clean openers are not flagged", () => {
  const good =
    "Marianna — I wrote a novel called Tamers of Entropy and I keep circling the same themes your Kestrel Mesh work touches. What got you into mesh routing?";
  assert.deepEqual(gradeIcebreaker(good, target, candidate), []);
  // Vocative address must not read as third person.
  assert.equal(isBriefing("Marianna, what would you want the first release to do?", "Marianna"), false);
  assert.equal(isBriefing("Hi Marianna — I'm building a payments app.", "Marianna"), false);
});

test("summarize splits the hard metric from the heuristic one", () => {
  const rows = [
    { violations: ["THEFT"] },
    { violations: ["FALSE_CLAIM", "BRIEFING"] },
    { violations: [] },
    { violations: [] },
  ];
  const s = summarize(rows);
  assert.equal(s.attributionErrors, 2);
  assert.equal(s.briefing, 1);
  assert.equal(s.clean, 2);
  assert.equal(s.cleanPct, 50);
});

test("admiring the other person's work is not a false claim", () => {
  // Regression from the first benchmark run: these are correct, friendly openers
  // and the grader called all of them FALSE_CLAIM because an "I" sat nearby.
  const ok = [
    "I read about Kestrel Mesh — the intersection of routing and privacy is fascinating.",
    "Hey Marianna — I read about Kestrel Mesh. Want to grab coffee?",
    "I'd love to hear about Kestrel Mesh and what you need next.",
  ];
  for (const t of ok) assert.deepEqual(gradeIcebreaker(t, target, candidate), [], t);
  // A genuine false claim still trips it.
  assert.deepEqual(gradeIcebreaker("I've been building my Kestrel Mesh for months.", target, candidate), [
    "FALSE_CLAIM",
  ]);
});
