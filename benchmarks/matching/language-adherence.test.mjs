/**
 * The language floor, pinned.
 *
 * There were two thresholds for one question — bakeoff.mjs shouted below 98,
 * bakeoff-report.mjs gated deployability below 95 — and the disagreement only
 * surfaced when arm D first measured the shipped prompt and the DEPLOYED model
 * drew the alarm at 97.7%. These cases are the real measurements that settled
 * where the line goes, so a future edit to the constant has to argue with them.
 *
 *   node --test language-adherence.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { IN_LANGUAGE_FLOOR_PCT, languageFloorCheck, detectLanguage } from "./language-adherence.mjs";

/** Arm D, R6 (the prompt production sends), 2026-09-10. */
const DEPLOYED_SK = { n: 1420, english: 29, czech: 1, inLanguagePct: 97.7 };
const DEPLOYED_EN = { n: 1416, english: 0, czech: 2, inLanguagePct: 99.8 };
/** The failure the gate exists to catch, same arm, same day. */
const QWEN_38_FLASH_SK = { n: 1073, english: 697, czech: 1, inLanguagePct: 34.5 };
/** The deployed model on R3, the pre-fix prompt: the subtle regression. */
const PRE_FIX_BEST_DRAW = { n: 1391, english: 90, czech: 0, inLanguagePct: 93.3 };
const PRE_FIX_WORST_DRAW = { n: 1440, english: 417, czech: 0, inLanguagePct: 70.7 };

test("the model we actually ship clears the floor", () => {
  assert.equal(languageFloorCheck("sk", DEPLOYED_SK).ok, true);
  assert.equal(languageFloorCheck("en", DEPLOYED_EN).ok, true);
});

test("the failure that motivated the round does not", () => {
  const v = languageFloorCheck("sk", QWEN_38_FLASH_SK);
  assert.equal(v.ok, false);
  assert.match(v.detail, /34\.5% of sk openers/);
  assert.match(v.detail, /697 English/);
});

test("both draws of the pre-fix regression are caught, including the lucky one", () => {
  // 93.3% was quoted in three rounds as if it were the model's real rate. The
  // floor has to catch the flattering draw, not just the ugly one.
  assert.equal(languageFloorCheck("sk", PRE_FIX_BEST_DRAW).ok, false);
  assert.equal(languageFloorCheck("sk", PRE_FIX_WORST_DRAW).ok, false);
});

test("the floor sits between the two, with room on the deployed side", () => {
  assert.ok(IN_LANGUAGE_FLOOR_PCT > PRE_FIX_BEST_DRAW.inLanguagePct,
    "a floor at or below 93.3 would have cleared the shipped regression");
  assert.ok(IN_LANGUAGE_FLOOR_PCT < DEPLOYED_SK.inLanguagePct,
    "a floor above 97.7 fails the model in production, which is how a gate stops being read");
});

test("detectLanguage still separates the three languages it has to", () => {
  // Czech and Slovak share diacritics, so these are the exclusive markers.
  assert.equal(detectLanguage("Ahoj, som embedded inžinierka a hľadám hardvér.", "sk"), "target");
  assert.equal(detectLanguage("Dobrý den, jsem embedded inženýrka a hledám hardware.", "sk"), "czech");
  assert.equal(detectLanguage("Hi Kenji, I'm an embedded engineer looking for hardware.", "sk"), "english");
});
