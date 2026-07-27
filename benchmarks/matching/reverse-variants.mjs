/**
 * The reverse-batch prompt variants, shared by the two benchmarks that need them:
 * icebreaker-run.mjs (does the prompt keep straight who is writing to whom) and
 * reverse-score-run.mjs (did changing it move the SCORES). Both must send exactly
 * the same bytes for a given variant or the two answers are about different
 * prompts, which is the whole reason this is a module and not copy-paste.
 *
 * Every variant starts from production's own text — imported from the built
 * coordinator, never retyped — and edits the parts under test back to their
 * historical wording:
 *
 *   R2 = the prompt deployed 2026-07-25 ("bind ROLES, not English pronouns"). It
 *        cleared this shape's third-party briefings and did nothing measurable for
 *        attribution (1/171 → 1/182), which is why R3 exists.
 *   R3 = live. It adds one system bullet (BLOCK ORDER IS NOT ROLE ORDER) and
 *        restructures the user block so each SENDER is named above the shared
 *        person and again inside its own entry.
 *
 * Rebuild dist before importing this, or you are benchmarking the old prompt:
 *   pnpm --filter @nostrautica/coordinator build
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const { REVERSE_BATCH_SYSTEM_PROMPT, buildReverseBatchUserBlock, languageInstruction } =
  await import(join(here, "../../packages/coordinator/dist/matching/scoring.js"));

/** Start of the icebreaker block in either system prompt; ends at the return line. */
export const START = "icebreakers —";
export const REV_END = "\n\nReturn one entry per target";

/** Replace exactly one occurrence, and fail loudly when the anchor has moved. */
export function replaceOnce(text, needle, replacement) {
  if (!text.includes(needle)) throw new Error(`user-block anchor missing: ${needle.slice(0, 48)}…`);
  return text.replace(needle, replacement);
}

// The 2026-07-25 reverse icebreaker block, verbatim, as the control R3 has to beat.
// Verbatim rather than derived: if it were computed by removing R3's additions, a
// later edit to the live block would silently move the control too, and the two
// would stop being a controlled comparison without anything failing.
export const R2_BLOCK = [
  "icebreakers — up to THREE opening MESSAGES THIS target can send the shared person. The app pastes",
  "the FIRST one straight into a direct-message box addressed to the shared person, so it must be",
  "sendable as-is, with no editing.",
  "WHO IS WHO. This is the most important rule. Compared with the field above only the PRONOUNS",
  "change — the two people keep their roles, they never swap:",
  ' • SENDER = THIS target. They are typing, so first person ("I"/"my") is always them. Everything',
  "   under this target's own heading — their book, app, courses, company, job, skills — is the",
  '   SENDER\'s own and is "my", NEVER "your".',
  ' • RECIPIENT = the SHARED person. Second person ("you"/"your") is always them. Only what appears',
  '   in the SHARED PERSON block may be called "your".',
  " • Never hand one person's work to the other. If the SENDER wrote a novel, never ask the",
  '   RECIPIENT about "your novel" — the SENDER wrote it, so it is "my novel". If the RECIPIENT',
  '   built a tool, never call it "my tool". The SENDER does not borrow the RECIPIENT\'s job,',
  "   profession or skills either.",
  " • WHOSE IS IT, when both profiles name the same thing: the shared person's profile may mention",
  "   something the SENDER made — they read it, funded it, drew its cover, did its branding, or list",
  '   it as a "hot project" they worked on. A mention does NOT transfer authorship. Each target\'s own',
  "   block is the authority on what that SENDER made: anything it presents as theirs stays \"my\",",
  "   however prominently the shared person lists it.",
  '   MECHANICAL CHECK before you write "your <name>" (or that phrase in another language): find that',
  "   name in BOTH blocks. If it appears in THIS target's own block at all, the phrase is FORBIDDEN —",
  '   it is the SENDER\'s, so write "my <name>". Only a name that appears solely in the SHARED PERSON',
  '   block may take "your". Their contribution to it ("your cover", "your branding") still takes',
  "   second person; the thing itself does not.",
  " • Write a message, not a briefing. Describing the two of them to a third party (\"You're a",
  '   cypherpunk and she studies X — ask her about Y") cannot be sent to anyone; do not do it.',
  " • This is a rule about ROLES, not about the English words. It holds in whatever language you",
  "   write in: use that language's own first-person possessive forms for the SENDER and its",
  "   second-person possessive forms for the RECIPIENT. The forms change; the owner never does.",
  "Re-read each icebreaker before returning it: every second-person possessive must point at",
  "something from the SHARED PERSON block, every first-person one at something from THIS target's",
  "own block. If one does not, the roles got swapped — rewrite it.",
  'Example of GOOD: "Hi Sunny — I\'m putting a band together and I hear you play bass. What would you',
  'want our first setlist to sound like?"',
  'Example of BAD (never do this): "You\'re starting a band and Sunny plays bass — ask her about your',
  'first setlist."',
  "Example of BAD (the trap): the shared person's profile proudly lists the SENDER's novel, because",
  'they designed its cover. "What style did you have in mind for your novel?" is WRONG — the SENDER',
  'wrote the novel, so it is "my novel"; only the cover is "your" work.',
  "Each ≤ 280 chars, concrete, grounded in both profiles, and different from one another. Return fewer",
  "(or none) rather than pad.",
].join("\n");

/** Swap the icebreaker block of the reverse system prompt for a historical one. */
export function spliceReverseBlock(prompt, block) {
  const i = prompt.indexOf(START);
  const j = prompt.indexOf(REV_END);
  if (i === -1 || j === -1 || j < i) throw new Error("could not locate the reverse icebreaker block");
  return prompt.slice(0, i) + block + prompt.slice(j);
}

// The 2026-07-25 reverse restructure, undone. A control has to be the user block as
// it was BEFORE it: the writer directory above the shared person, the per-entry
// writer lines, and the extra clause on the TARGET ATTENDEES heading are what R3
// adds, and they are generated per target (names, entry numbers), so they come off
// by pattern rather than by exact string. Every removal is asserted, so a reworded
// live block fails loudly here instead of quietly turning the control into a second
// copy of R3.
const REV_TARGETS_HEADING_R3 =
  "TARGET ATTENDEES: one numbered block per WRITER — the icebreakers in entry n are typed by TARGET n.";
export function stripReverseDirection(u) {
  const start = u.indexOf("WHO WRITES EACH ENTRY");
  const end = u.indexOf("\n\nSHARED PERSON (", start);
  if (start === -1 || end === -1) throw new Error("reverse writer directory missing from the live block");
  // Drop the directory AND the blank line that separated it, so what remains is the
  // preamble followed directly by the shared person's heading, as it was.
  let out = u.slice(0, start) + u.slice(end + 2);
  const before = out;
  out = out.replace(/\n\(Entry \d+ is written BY the TARGET \d+ profile above, TO [^\n]*\)/g, "");
  if (out === before) throw new Error("per-entry writer lines missing from the live block");
  out = replaceOnce(out, REV_TARGETS_HEADING_R3, "TARGET ATTENDEES:");
  if (/WHO WRITES|written BY the TARGET/.test(out)) throw new Error("reverse strip left R3 text behind");
  return out;
}

/**
 * What a control actually sends is only as good as the strip, and the strip is
 * pattern-based — so assert the restored layout: preamble → shared heading →
 * profile → recipient line → TARGET ATTENDEES: → sender lines → delimiter/profile
 * pairs with nothing between them. That IS the pre-restructure block.
 */
export function assertStrippedLayout(r2) {
  if (!r2.includes("other's work.\n\nSHARED PERSON (the one each target below would meet):")) {
    throw new Error("R2 user block: the writer directory did not come off cleanly");
  }
  if (!r2.includes('TARGET ATTENDEES:\n(Each target is the SENDER')) {
    throw new Error("R2 user block: TARGET ATTENDEES heading not restored");
  }
  if (/^\(Entry /m.test(r2) || /^ {2}entry \d+:/m.test(r2)) throw new Error("R2 user block: R3 lines remain");
}

// R2 keeps the CURRENT languageInstruction: the 2026-07-25 change to that block
// shipped with the wording it controls for, so re-testing it here would confound
// two fixes. R3 sends production's bytes untouched, in both prompts.
export const REVERSE_VARIANTS = {
  R2: {
    label: "R2-roles",
    shape: "reverse",
    system: (lang) => spliceReverseBlock(REVERSE_BATCH_SYSTEM_PROMPT, R2_BLOCK) + languageInstruction(lang),
    user: (u) => {
      const out = stripReverseDirection(u);
      assertStrippedLayout(out);
      return out;
    },
  },
  R3: {
    label: "R3-order",
    shape: "reverse",
    system: (lang) => REVERSE_BATCH_SYSTEM_PROMPT + languageInstruction(lang),
    user: (u) => u,
  },
};

// Import-time self-checks, so a stale dist or a reworded prompt is caught before
// any API budget is spent rather than after: the splice must round-trip, and the
// live block must not have become identical to its own control.
{
  const currentBlock = REVERSE_BATCH_SYSTEM_PROMPT.slice(
    REVERSE_BATCH_SYSTEM_PROMPT.indexOf(START),
    REVERSE_BATCH_SYSTEM_PROMPT.indexOf(REV_END),
  );
  if (spliceReverseBlock(REVERSE_BATCH_SYSTEM_PROMPT, currentBlock) !== REVERSE_BATCH_SYSTEM_PROMPT) {
    throw new Error("reverse splice self-check failed");
  }
  if (currentBlock === R2_BLOCK) {
    throw new Error("live reverse block equals R2 — is dist stale? (pnpm --filter @nostrautica/coordinator build)");
  }
  if (!REVERSE_BATCH_SYSTEM_PROMPT.includes("BLOCK ORDER IS NOT ROLE ORDER")) {
    throw new Error("live reverse block is missing R3's block-order rule — is dist stale?");
  }
}
