/**
 * Properties the dense reverse bucket must have, or the number it produces is
 * about something other than what it claims.
 *
 *   node --test icebreaker-fixture.test.mjs
 *
 * This exists because the sparse bucket's defect was invisible for two rounds of
 * results: only one of k entries was ever a trap, so every rate it reported was
 * diluted by the k−1 ordinary pairs sitting in the denominator, and nothing said
 * so. A fixture whose trap density is wrong does not fail — it quietly reports a
 * smaller number, which reads like good news.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReverseDenseCases, buildReverseCases, PERSONA_BY_ID } from "./icebreaker-fixture.mjs";

/** Everything the model actually sees of a profile. */
const profileText = (p) =>
  [p.ai_profile.summary, ...p.ai_profile.skills, ...p.ai_profile.interests, ...p.ai_profile.offers,
   ...p.ai_profile.seeks].join(" | ");

test("dense: EVERY target's artifact appears in the shared person's profile", () => {
  const cases = buildReverseDenseCases(10);
  assert.ok(cases.length >= 8, "want at least eight distinct shared people");
  for (const c of cases) {
    const shared = profileText(c.shared);
    for (const t of c.targets) {
      assert.ok(
        shared.includes(t.signature.entity),
        `${c.shared.id}: ${t.signature.entity} (${t.id}) is not in the shared profile — that entry is not a trap`,
      );
    }
  }
});

test("dense: the trap density really is 100%, vs 1/k in the sparse bucket", () => {
  const k = 10;
  const dense = buildReverseDenseCases(k);
  for (const c of dense) assert.equal(c.targets.length, k);

  // The sparse bucket's actual density, stated as a test so the contrast is a
  // fact in the repo rather than a claim in a comment.
  for (const c of buildReverseCases(k)) {
    const shared = profileText(c.shared);
    const traps = c.targets.filter((t) => shared.includes(t.signature.entity)).length;
    assert.ok(traps <= 1, `sparse case ${c.shared.id} has ${traps} traps; the bucket is defined as at most one`);
  }
});

test("dense: the shared person keeps their own artifact, so FALSE_CLAIM stays measurable", () => {
  for (const c of buildReverseDenseCases(10)) {
    assert.ok(
      profileText(c.shared).includes(c.shared.signature.entity),
      `${c.shared.id} lost its own signature artifact; a sender claiming it as "my" would be ungradeable`,
    );
    // ...and no target may own it, or "my <shared artifact>" would be legitimate
    // for that target and the check would fire on a correct opener.
    for (const t of c.targets) {
      assert.notEqual(t.signature.entity, c.shared.signature.entity);
    }
  }
});

test("dense: the shared person is never also one of the targets", () => {
  for (const c of buildReverseDenseCases(10)) {
    const base = c.shared.id.replace(/-shares-all$/, "");
    for (const t of c.targets) assert.notEqual(t.id, base);
  }
});

test("dense clones resolve through PERSONA_BY_ID, so saved runs can be re-graded", () => {
  // icebreaker-regrade.mjs looks rows up by id and throws on an unknown one; a
  // run that cannot be re-graded cannot survive the next grader correction, and
  // this benchmark has had four of those.
  for (const c of buildReverseDenseCases(10)) {
    const found = PERSONA_BY_ID.get(c.shared.id);
    assert.ok(found, `${c.shared.id} is not registered in PERSONA_BY_ID`);
    assert.equal(found.signature.entity, c.shared.signature.entity);
    assert.equal(found.firstName, c.shared.firstName);
    for (const t of c.targets) assert.ok(PERSONA_BY_ID.get(t.id), `${t.id} is not registered`);
  }
});

test("dense: k=4 registers the same ids as k=10 (regrade is k-independent)", () => {
  // PERSONA_BY_ID is built from the k=10 clones. A run at another k must still
  // resolve, which holds only because the id does not encode k.
  for (const c of buildReverseDenseCases(4)) {
    assert.ok(PERSONA_BY_ID.get(c.shared.id), `${c.shared.id} would not resolve when re-grading a k=4 run`);
  }
});
