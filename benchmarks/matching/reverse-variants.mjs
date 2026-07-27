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
/**
 * R4 asks the model to NAME the two roles in the output, per entry, immediately
 * before it writes that entry's icebreakers.
 *
 * Rationale: R2 and R3 are both attempts to make the roles unmissable on the way
 * IN — wording, then layout. Neither can do anything about the fact that by the
 * time the model is emitting opener #3 of entry #7, the binding line for entry 7 is
 * hundreds of tokens back and the shared person's profile is the nearest, longest
 * block of concrete nouns. Generation is autoregressive, so the cheapest place to
 * restate the binding is in the model's own output, in the token positions right
 * before the openers: the model reads what it just wrote.
 *
 * THE FIELD NAMES ARE LOad-BEARING, and not for readability. Venice's structured
 * output emits object keys in ALPHABETICAL order, not in the order the schema
 * lists them — verified on every cached response in this directory, which all come
 * back `complementarity, icebreakers, index, reasoning_for_target, score,
 * similarity`. So a field called `writer_name` would be generated AFTER the
 * icebreakers and steer nothing; the first draft of this variant did exactly that
 * and would have measured a no-op at full cost. `addressed_to` and `authored_by`
 * sort ahead of `complementarity`, so they are the first two things the model
 * writes in every entry.
 *
 * (The same fact has a free corollary worth knowing: production's `icebreakers`
 * are already generated BEFORE `reasoning_for_target`, so the openers are not
 * written "after" the reasoning however the prompt is worded.)
 *
 * Cost if this ships: ~15 tokens per entry. The coordinator's parser ignores
 * unknown fields, so the fields are diagnostic only — nothing downstream reads
 * them, they exist to steer the decode.
 */
export const ROLE_FIELDS = ["addressed_to", "authored_by"];

export function withSelfLabelling(schema) {
  const item = schema.properties.matches.items;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      matches: {
        ...schema.properties.matches,
        items: {
          ...item,
          required: [...item.required, ...ROLE_FIELDS],
          properties: {
            addressed_to: { type: "string" },
            authored_by: { type: "string" },
            ...item.properties,
          },
        },
      },
    },
  };
}

export const SELF_LABEL_INSTRUCTION = [
  "",
  "ROLE FIELDS. Every entry starts with two fields that fix who is speaking, and they come out",
  "before anything else in the entry. Fill them first, then write the rest of the entry to agree",
  "with what you just wrote:",
  " • authored_by — the Name from THIS entry's own TARGET block. That person is typing this entry's",
  '   icebreakers, so everything in their block is "my".',
  ' • addressed_to — the Name from the SHARED PERSON block. That person is being written TO, so',
  '   everything in their block is "your". It is the same name in every entry.',
  "Copy both names exactly as spelled in the blocks; do not translate them. Then, in the icebreakers:",
  'anything called "your" must come from addressed_to\'s block, and anything of authored_by\'s stays',
  '"my".',
].join("\n");

/**
 * R5 does the thing R3 only approximated: it physically prints the WRITERS first
 * and the shared person LAST, mirroring the forward block, whose one structural
 * advantage is that its first-printed person is the sender. R3 kept the shared
 * person on top and countered it with a directory and per-entry lines; R5 removes
 * the thing being countered.
 *
 * This is a benchmark-only variant with a real production cost attached, which is
 * why it is measured before it is considered: coordinator.test.ts's fake LLM
 * decides who it was asked about by slicing the user block on `SHARED PERSON (`,
 * then `TARGET ATTENDEES:`, then `--- TARGET n ---`, IN THAT ORDER, and
 * scoring.test.ts pins those three landmarks. Shipping this shape means rewriting
 * both. Worth doing only if it wins by a margin the fixture can actually resolve.
 */
const SHARED_HEAD = "\n\nSHARED PERSON (the one each target below would meet):";
const TARGETS_HEAD = "\n\nTARGET ATTENDEES: one numbered block per WRITER";
const PRINTED_FIRST = " writes nothing and is only read — being printed first does not make them the writer.";

export function reorderWritersFirst(u) {
  const s = u.indexOf(SHARED_HEAD);
  const t = u.indexOf(TARGETS_HEAD);
  if (s === -1 || t === -1 || t < s) throw new Error("R5: could not locate the shared/targets sections");
  const head = u.slice(0, s);
  const shared = u
    .slice(s, t)
    .replace("the one each target below would meet", "the one each target above would meet")
    .replace("is the RECIPIENT of every icebreaker below:", "is the RECIPIENT of every icebreaker above:");
  const targets = u.slice(t);
  // The directory's closing line argues against an order that no longer exists.
  if (!head.includes(PRINTED_FIRST)) throw new Error("R5: directory closing line missing");
  const out =
    head.replace(
      PRINTED_FIRST,
      " writes nothing and is only read — their profile is printed LAST, after every writer.",
    ) +
    targets +
    shared;
  if (out.indexOf("SHARED PERSON (") < out.indexOf("--- TARGET 1 ---")) {
    throw new Error("R5: the shared block did not move below the targets");
  }
  return out;
}

// R5's system prompt cannot keep R3's BLOCK ORDER bullet: it describes a layout R5
// does not have, and a prompt that misdescribes its own user block is not a fair
// control either way. So the bullet is restated for the new order — meaning R5
// differs from R3 by a layout change AND the paragraph that narrates it, which is
// the honest way to test "does print order matter" and not a clean single-variable
// experiment.
const R3_ORDER_BULLET = [
  " • BLOCK ORDER IS NOT ROLE ORDER. The shared person is printed FIRST only because they are the",
  "   same person in every entry. Printed first does not mean speaking. The writer of entry n is",
  "   TARGET n — never the shared person — and the line directly under each target's profile says",
  '   so ("Entry n is written BY the TARGET n profile above, TO …"). If the order the blocks are',
  "   printed in ever seems to disagree with that line, the line is right.",
].join("\n");
const R5_ORDER_BULLET = [
  " • WRITERS ARE PRINTED FIRST. Every numbered TARGET block is a WRITER. They come first, and the",
  "   shared person is printed LAST, because they are the same person in every entry and never",
  "   write anything — they are only read. The writer of entry n is TARGET n, and the line directly",
  '   under each target\'s profile says so ("Entry n is written BY the TARGET n profile above, TO …").',
].join("\n");

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
  // R4 = R3 plus the self-labelling fields. R3 is its control, and the only
  // difference is the schema and the paragraph that explains it.
  R4: {
    label: "R4-selflabel",
    shape: "reverse",
    system: (lang) => REVERSE_BATCH_SYSTEM_PROMPT + languageInstruction(lang) + SELF_LABEL_INSTRUCTION,
    user: (u) => u,
    schema: withSelfLabelling,
  },
  // R5 = R3 with the blocks physically reordered, writers first.
  R5: {
    label: "R5-writersfirst",
    shape: "reverse",
    system: (lang) =>
      replaceOnce(REVERSE_BATCH_SYSTEM_PROMPT, R3_ORDER_BULLET, R5_ORDER_BULLET) + languageInstruction(lang),
    user: reorderWritersFirst,
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
