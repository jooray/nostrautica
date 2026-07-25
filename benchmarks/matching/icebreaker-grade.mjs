/**
 * Objective grading for match icebreakers. No LLM judge, no human rubric — every
 * check below is a hard pass/fail against a known-owner artifact, which is what
 * makes this cheap enough to run on every prompt change.
 *
 * What we are measuring, and why each check exists (all three are real prod
 * failures from 2026-07-24, not hypotheticals):
 *
 *  1. THEFT — the target's own artifact offered back to them as the candidate's
 *     ("Can your book Tamers of Entropy get a new brand?" — the reader wrote it).
 *  2. FALSE CLAIM — the mirror error: the target claims the candidate's artifact
 *     as their own ("my Kestrel Mesh" when it is the candidate's).
 *  3. BRIEFING — text that describes the pair to a third party ("You're a
 *     cypherpunk — Psychiatric Ward studies mental health. Ask them about X").
 *     Reads fine on the card, but the "Introduce us" button pastes icebreakers[0]
 *     straight into a DM addressed to that person, where it is nonsense.
 *
 * Reported separately: THEFT/FALSE CLAIM are near-zero-false-positive (they hinge
 * on an invented proper noun with exactly one owner), while BRIEFING is heuristic
 * and can misfire. Keeping them apart means a soft signal cannot contaminate the
 * hard number.
 */

/** Characters of context before an entity mention that can carry its possessive. */
const WINDOW = 70;

/**
 * Whose does this text claim `entity` is? Looks at the run of text leading up to
 * the mention — that is where the possessive sits in every natural phrasing
 * ("your novel X", "my novel X", "the novel X you wrote").
 * Returns "second" (yours), "first" (mine), or "none".
 */
export function attributionOf(text, entity) {
  const idx = text.toLowerCase().indexOf(entity.toLowerCase());
  if (idx === -1) return "none";
  const before = text.slice(Math.max(0, idx - WINDOW), idx);
  const after = text.slice(idx + entity.length, idx + entity.length + WINDOW);
  // Only a real POSSESSIVE counts. Requiring just a nearby "I"/"you" over-fires
  // badly: "I read about The Vellum Cipher" is someone admiring the other
  // person's work, not claiming it — the first benchmark run scored seven of
  // those as false claims and the number was meaningless until this was tightened.
  // Nearest possessive wins, so "I loved your Nightjar Ledger" is second person
  // despite the earlier "I".
  const second = lastMatch(before, /\byour\b/gi);
  const first = lastMatch(before, /\bmy\b/gi);
  if (/^\s*(of|,)?\s*yours\b/i.test(after)) return "second";
  if (/^\s*(of|,)?\s*mine\b/i.test(after)) return "first";
  if (second === -1 && first === -1) return "none";
  return second > first ? "second" : "first";
}

function lastMatch(s, re) {
  let last = -1;
  for (const m of s.matchAll(re)) last = m.index;
  return last;
}

/**
 * Does this read as a briefing about the pair rather than a message to them?
 * Signals, any one of which is decisive:
 *  - an instruction to the reader to go talk to a third party ("ask her about")
 *  - the addressee referred to in the THIRD person by name ("Sunny plays bass") —
 *    legitimate vocative use ("Hi Sunny — ...", "Sunny, what would...") is
 *    excluded by requiring a verb rather than punctuation after the name.
 */
export function isBriefing(text, candidateFirstName) {
  if (/\b(ask|tell|grab|find|meet|talk to|reach out to)\s+(her|him|them)\b/i.test(text)) return true;
  const name = candidateFirstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const thirdPerson = new RegExp(
    `\\b${name}\\b\\s+(?:also\\s+|just\\s+|currently\\s+)?` +
      `(is|was|has|does|studies|plays|works|builds|writes|runs|makes|leads|hosts|designs|maintains|founded|wrote|built)\\b`,
    "i",
  );
  return thirdPerson.test(text);
}

/**
 * Grade one icebreaker for a (target, candidate) pair.
 * Returns the list of violation codes it triggers (empty = clean).
 */
export function gradeIcebreaker(text, target, candidate) {
  const bad = [];
  if (attributionOf(text, target.signature.entity) === "second") bad.push("THEFT");
  if (attributionOf(text, candidate.signature.entity) === "first") bad.push("FALSE_CLAIM");
  if (isBriefing(text, candidate.firstName)) bad.push("BRIEFING");
  return bad;
}

/** Aggregate per-icebreaker grades into the numbers we compare between prompts. */
export function summarize(rows) {
  const total = rows.length;
  const count = (code) => rows.filter((r) => r.violations.includes(code)).length;
  const theft = count("THEFT");
  const falseClaim = count("FALSE_CLAIM");
  const briefing = count("BRIEFING");
  const clean = rows.filter((r) => r.violations.length === 0).length;
  const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  return {
    total,
    // The headline number: attribution is the thing that was demonstrably broken.
    attributionErrors: theft + falseClaim,
    attributionErrorPct: pct(theft + falseClaim),
    theft,
    falseClaim,
    briefing,
    briefingPct: pct(briefing),
    clean,
    cleanPct: pct(clean),
  };
}
