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
  // An earlier "I" must not beat a nearer "your". (The example used to say "your
  // Kestrel Mesh work"; round five made a trailing SERVICE noun mean the possessive
  // claims the service and not the artifact, so it now reads "none" there and the
  // precedence has to be shown on a noun that is the artifact's own category.)
  assert.equal(attributionOf("I really enjoyed your Kestrel Mesh project", "Kestrel Mesh"), "second");
  assert.equal(attributionOf("I really enjoyed your Kestrel Mesh work", "Kestrel Mesh"), "none");
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

test("regressions found by re-grading the saved 2026-07-24 run", () => {
  // Both of these were graded wrong by the sharpened grader before it was pinned
  // here — and both are correct, sendable openers, i.e. exactly the kind of false
  // positive that made an earlier benchmark run meaningless.
  // 1. An invitation is not a transfer of ownership: Lars runs the supper club.
  const invite =
    "Hey Elena — I host a supper club and love conversations that bridge different worlds. If you ever want to talk cryptography over a meal, Vantablack Kitchen is your place.";
  assert.equal(attributionOf(invite, "Vantablack Kitchen"), "none");
  // …but a bare trailing possessive still is one.
  assert.equal(attributionOf("Is Vantablack Kitchen yours?", "Vantablack Kitchen"), "second");
  assert.equal(attributionOf("Vantablack Kitchen je tvoja, však?", "Vantablack Kitchen"), "second");
  // 2. "I'm building X" outranks an earlier "your" — the nearest claim wins.
  const mine =
    "Your Kestrel Mesh stack sounds fascinating — I'm building Handbasket Rails for grassroots payments, and I'd love to hear how you think about making complex tech usable.";
  assert.equal(attributionOf(mine, "Handbasket Rails"), "first");
  assert.equal(attributionOf(mine, "Kestrel Mesh"), "second");
});

// Real deepseek-v4-flash output from the 2026-07-25 en+sk run. Every single row
// the grader flagged in that run was a FALSE POSITIVE, in two families:
//  - a possessive in the PREVIOUS sentence ("…tvoja práca na Kestrel Mesh znie
//    skvele. Mám Handbasket Rails…"), which governs a noun in that sentence, not
//    this one;
//  - a first-person claim in the simple present ("I host Salt & Signal", "ja mám
//    Sundial Custody", "pracujem na Kestrel Mesh"), which the grader could not
//    read, so an earlier "your"/"tvoja" won the nearest-claim comparison by
//    default.
// Both families are pinned here because they made a whole benchmark run
// unreadable: the prompt looked like it had regressed when only the grader had.
test("false positives from the 2026-07-25 run: previous-sentence possessives", () => {
  const cases = [
    // [text, entity, expected]
    ["Casimir — your self-custody workshops sound great. I host Salt & Signal and I'd love to have you on to talk about reaching non-technical users with privacy tools.", "Salt & Signal", "first"],
    ["Ahoj, som nadšený z tvojho nápadu s Handbasket Rails. Hľadáš Rust inžiniera a ja mám Sundial Custody – možno by sme našli spoločnú reč.", "Sundial Custody", "first"],
    ["Čau Dmitri, počul som o tvojom crate Ferrous Tideline. Ja mám Petrichor Fund, ktorý by mohol podporiť open-source infraštruktúru — aká je tvoja predstava ideálneho projektu?", "Petrichor Fund", "first"],
    ["Ahoj Jonah — tvoja práca na Kestrel Mesh znie skvele. Mám Handbasket Rails, ktorý potrebuje práve taký UX dizajn, aký robíš. Chcel by si to rozobrať?", "Handbasket Rails", "first"],
    ["Ahoj Bao, čítal som tvoju prácu o Ostrich Protokole a pracujem na Kestrel Mesh — tvoja potreba nájsť vzory v transakčných dátech by sa dala pekne spojiť s UX výskumom.", "Kestrel Mesh", "first"],
    ["Ahoj Gideon, tvoja práca na ochrane whistleblowerov je dôležitá. Ja vyvíjam Sundial Custody, knižnicu na správu kľúčov — možno by sme sa porozprávali?", "Sundial Custody", "first"],
    ["Ahoj Lars, počul som o tvojom Vantablack Kitchen – znie to skvele. Ja vediem Longshore Atlas, mapovací projekt.", "Longshore Atlas", "first"],
    ["Ahoj Jonah — mám technický produkt, ktorý potrebuje tvoju dizajnérsku citlivosť. Chcel by si pomôcť spraviť Handbasket Rails použiteľným pre ľudí, ktorí nie sú kryptografi?", "Handbasket Rails", "none"],
  ];
  for (const [text, entity, want] of cases) assert.equal(attributionOf(text, entity), want, text);
  // A possessive that governs the artifact directly still reads as the
  // recipient's ("počul som o tvojom Vantablack Kitchen").
  assert.equal(attributionOf(cases[6][0], "Vantablack Kitchen"), "second");
  // Where the possessive governs an intervening noun instead ("tvojho nápadu s
  // Handbasket Rails", "tvoja práca na Kestrel Mesh") the text asserts no
  // ownership of the artifact at all — which is fine: neither error can fire, and
  // guessing "second" there is what produced the false THEFTs in the first place.
  assert.equal(attributionOf(cases[1][0], "Handbasket Rails"), "none");
  assert.equal(attributionOf(cases[3][0], "Kestrel Mesh"), "none");
});

test("a possessive on a CONTRIBUTION is not a claim on the artifact", () => {
  // The other seventeen-of-seventeen false positives from the trap run: the
  // recipient really did do the branding / the artwork / the work — the artifact
  // it was done FOR is still the sender's, and saying so is the correct opener.
  const t = { firstName: "Priya", signature: { entity: "The Vellum Cipher", kind: "novel", verb: "wrote" } };
  const c = { firstName: "Gideon", signature: { entity: "Pelagic Standard", kind: "design system", verb: "designed" } };
  const ok = [
    "Your branding for The Vellum Cipher was incredible. I'd love to hear how you think about storytelling and legal risk together.",
    "Your visual identity work on The Vellum Cipher caught my eye — I'd love to talk about how you approach storytelling through design.",
    "Ahoj Gideon, viem, že si navrhol branding pre The Vellum Cipher – páčilo sa mi to! Poradíš mi s právnou ochranou zdrojov?",
    "Gideon, tvoja práca na The Vellum Cipher ma nadchla. Mám ďalší projekt, ktorý by si mohol vizuálne uchopiť.",
    "Som zvedavý, aké bolo tvoje prvé stretnutie s The Vellum Cipher — čo ťa na ňom najviac zaujalo?",
  ];
  for (const text of ok) assert.deepEqual(gradeIcebreaker(text, t, c), [], text);
  // But "your courses on <the sender's site>" IS theft: courses are content
  // published under the site, not a service rendered to it. This is the real prod
  // failure and it must survive the rule above.
  const courses = { firstName: "Juraj", signature: { entity: "hackyourself.io", kind: "courses", verb: "runs" } };
  assert.deepEqual(gradeIcebreaker("Rád by som sa dozvedel viac o tvojich kurzoch na hackyourself.io.", courses, c), [
    "THEFT",
  ]);
});

test("a dash separates clauses; a comma is apposition", () => {
  const t = { firstName: "Priya", signature: { entity: "The Vellum Cipher", kind: "novel", verb: "wrote" } };
  const c = { firstName: "Lars", signature: { entity: "Salt & Signal", kind: "podcast", verb: "hosts" } };
  // Real IB1 output: two clauses, the sender's podcast and the recipient's, and
  // the grader read "I host a podcast too — Salt & Signal" as a false claim.
  const ok = "I host a podcast too — Salt & Signal sounds fascinating. I'd love to chat about whether privacy tech can protect sources.";
  assert.deepEqual(gradeIcebreaker(ok, t, c), []);
  // A comma still carries the claim ("my novel, X").
  assert.equal(attributionOf("I keep going back to my novel, The Vellum Cipher.", "The Vellum Cipher"), "first");
});

test("the sentence cut does not hide a real theft", () => {
  // Genuine errors keep the possessive in the same sentence as the artifact —
  // all three pinned prod failures above do — so the cut costs no detection.
  assert.equal(attributionOf("Mám vlastný projekt. Tvoja kniha Krotitelia entropie ma nadchla.", "Krotitelia entropie"), "second");
  assert.equal(attributionOf("I run a supper club. Your novel Tamers of Entropy is great.", "Tamers of Entropy"), "second");
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

// ── Slovak: the failure the English-only grader could not see ────────────────
// Prod 2026-07-25, live Slovak event. All three icebreakers for ONE candidate
// were inverted: the reader was written as the candidate's profession and handed
// their own app, novel and courses as the candidate's. Pinned verbatim (only the
// entity names are the reader's real ones) — these six strings are the reason
// this grader learned Slovak, so they are the regression suite for it.
const skReader = { firstName: "Juraj", signature: { entity: "Nostrautica", kind: "app", verb: "built" } };
const skBook = { firstName: "Juraj", signature: { entity: "Krotitelia entropie", kind: "novel", verb: "wrote" } };
const skCourses = { firstName: "Juraj", signature: { entity: "hackyourself.io", kind: "courses", verb: "runs" } };
/** The candidate: a creative producer whose own bio led with the reader's book. */
const skCand = { firstName: "Pavel", signature: { entity: "Zcash", kind: "wallet", verb: "builds" } };

test("SK THEFT: 'si vytvoril X' — ownership stated with a verb, no possessive", () => {
  // "I heard you created Nostrautica — I do branding": the reader's own app given
  // away AND the candidate's profession claimed. Note the accusative
  // "Nostrauticu": an exact substring match on "Nostrautica" finds nothing here,
  // which is exactly how this graded clean before.
  const bad =
    "Ahoj, počul som, že si vytvoril Nostrauticu — ja sa venujem brandingu a storytellingu, možno by sme spolu vymysleli, ako to lepšie odkomunikovať svetu. Čo hovoríš?";
  assert.equal(attributionOf(bad, "Nostrautica"), "second");
  assert.deepEqual(gradeIcebreaker(bad, skReader, skCand), ["THEFT"]);
});

test("SK THEFT: 'Tvoja kniha X' — second-person possessive on the reader's novel", () => {
  const bad =
    "Tvoja kniha Krotitelia entropie znie presne ako niečo, čo by som chcel vizuálne spracovať. Máš predstavu, aký by mal mať obal štýl?";
  assert.deepEqual(gradeIcebreaker(bad, skBook, skCand), ["THEFT"]);
});

test("SK THEFT: 'tvojich kurzoch na X' — inflected possessive, entity behind a preposition", () => {
  const bad =
    "Rád by som sa dozvedel viac o tvojich kurzoch na hackyourself.io — možno by sme spoločne vytvorili nejaký vizuálny materiál.";
  assert.deepEqual(gradeIcebreaker(bad, skCourses, skCand), ["THEFT"]);
});

test("SK correct openers are NOT flagged", () => {
  // 1. The author asking whether the recipient has READ their novel. "čítal si"
  //    is a 2nd-person verb but a CONSUMPTION one — reading is not authorship,
  //    and treating it as one would flag the single best opener of the batch.
  //    "Krotiteľov entropie" is the genitive plural of the entity, ľ and all.
  const good1 =
    "Ahoj Pavel, čítal si Krotiteľov entropie? Rád by som ti porozprával o tom, ako sa gamma komunita prelína s cyberpunk víziami.";
  assert.equal(attributionOf(good1, "Krotitelia entropie"), "none");
  assert.deepEqual(gradeIcebreaker(good1, skBook, skCand), []);

  // 2. "I am the author of the novel … and creator of Nostrautica" — a
  //    first-person claim with no possessive at all, plus "tvoj Zcash" correctly
  //    pointing at the recipient's project.
  const good2 =
    "Ahoj, som autorom románu Krotitelia entropie a tvorcom Nostrauticy – rád by som ti ukázal, ako by sa dal tvoj Zcash prepojiť s Nostrom.";
  assert.equal(attributionOf(good2, "Krotitelia entropie"), "first");
  assert.equal(attributionOf(good2, "Zcash"), "second");
  assert.deepEqual(gradeIcebreaker(good2, skBook, skCand), []);

  // 3. Present tense first person: "I build the tool Nostrautica".
  const good3 = "Čau Pavel, tvorím nástroj Nostrautica na spoznávanie ľudí.";
  assert.equal(attributionOf(good3, "Nostrautica"), "first");
  assert.deepEqual(gradeIcebreaker(good3, skReader, skCand), []);
});

test("SK FALSE_CLAIM: the reader claims the recipient's project", () => {
  const bad = "Na mojom Zcash wallete pracujem už rok, chceš porovnať poznámky?";
  assert.deepEqual(gradeIcebreaker(bad, skReader, skCand), ["FALSE_CLAIM"]);
  // …and the verb form of the same error.
  assert.equal(attributionOf("Zcash som vytvoril ja, tak sa poďme baviť o ňom.", "Zcash"), "none");
  assert.equal(attributionOf("Nedávno som vytvoril Zcash wallet, ukážem ti ho.", "Zcash"), "first");
});

test("SK BRIEFING: third-person framing that cannot be sent as a message", () => {
  assert.equal(isBriefing("Pavel robí branding a storytelling, spýtaj sa ho na obal.", "Pavel"), true);
  assert.equal(isBriefing("Pavel je kreatívny producent — napíš mu o knihe.", "Pavel"), true);
  // Vocative address is a message, not a briefing.
  assert.equal(isBriefing("Ahoj Pavel, čítal si moju knihu?", "Pavel"), false);
  assert.equal(isBriefing("Čau Pavel, tvorím nástroj Nostrautica.", "Pavel"), false);
});

test("CS possessives: the same two errors in Czech", () => {
  const cs = { firstName: "Juraj", signature: { entity: "Tamers of Entropy", kind: "novel", verb: "wrote" } };
  const cand = { firstName: "Marianna", signature: { entity: "Kestrel Mesh", kind: "stack", verb: "maintains" } };
  assert.deepEqual(gradeIcebreaker("Tvoje knihy Tamers of Entropy jsem přečetl dvakrát.", cs, cand), ["THEFT"]);
  assert.deepEqual(gradeIcebreaker("Na mém Kestrel Mesh pracuji už rok.", cs, cand), ["FALSE_CLAIM"]);
  // "má" is Czech for "my" AND for "he/she has" — counting it would flag this
  // perfectly correct sentence, so it is deliberately not in the word list.
  assert.deepEqual(gradeIcebreaker("Marianna má Kestrel Mesh rozjetý, co dál?", cs, cand), ["BRIEFING"]);
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

test("round five: a SERVICE noun as the head is not a claim on the artifact", () => {
  // Real rows from the 2026-07-25 K=10 reverse run. In every one the model has
  // ownership RIGHT — the recipient did the branding, the sender founded the
  // conference — and the grader called them THEFT because the possessive sat next
  // to the artifact name. English makes a compound whose head is the service;
  // Slovak puts the service first and drops the preposition. Neither reached the
  // preposition branch that round four added.
  const founder = {
    firstName: "Theo",
    signature: { entity: "Ironwood Assembly", kind: "conference series", verb: "founded" },
  };
  const brander = {
    firstName: "Pia",
    signature: { entity: "Petrichor Fund", kind: "grant programme", verb: "runs" },
  };
  const ok = [
    "Your Ironwood Assembly branding is fantastic — I founded the conference series with the same name.",
    "Theo — I write checks into freedom tech. Your Ironwood Assembly branding is exactly the polish early teams need.",
    "Ahoj Theo, rád by som sa porozprával o tom, ako by tvoja vízia Ironwood Assembly mohla pomôcť môjmu mentorstvu.",
  ];
  for (const t of ok) assert.deepEqual(gradeIcebreaker(t, founder, brander), [], t);

  // The thefts from the SAME run must stay flagged: a category noun ("project",
  // "podcast", "dokument") means the possessive really does take the artifact.
  const drummer = { firstName: "Tom", signature: { entity: "Nightjar Ledger", kind: "audit toolkit", verb: "built" } };
  const hw = { firstName: "Sunny", signature: { entity: "Copperwake", kind: "hardware wallet", verb: "designed" } };
  assert.deepEqual(
    gradeIcebreaker("Hi Sunny — I'm a drummer looking for a bassist. Your Nightjar Ledger project shows great timing.", drummer, hw),
    ["THEFT"],
  );
  const host = { firstName: "Gid", signature: { entity: "Salt & Signal", kind: "podcast", verb: "hosts" } };
  const designer = { firstName: "Pav", signature: { entity: "Pelagic Standard", kind: "design system", verb: "designed" } };
  assert.deepEqual(
    gradeIcebreaker("Gideon, počúvam tvoj podcast Salt & Signal a rozmýšľam nad epizódou.", host, designer),
    ["THEFT"],
  );
  // And the bare possessive with nothing after it is untouched.
  assert.deepEqual(
    gradeIcebreaker("Ahoj, som zvedavý na tvoju Sundial Custody — spojíme to s mojou knižnicou?", {
      firstName: "Kai", signature: { entity: "Sundial Custody", kind: "key-management library", verb: "built" },
    }, designer),
    ["THEFT"],
  );
});

test("round five does not swallow the artifact whose category IS a design system", () => {
  // "design" is deliberately absent from SERVICE_NOUN: one persona's artifact is a
  // design system, so treating the word as a service would hide a real theft.
  const owner = { firstName: "Pav", signature: { entity: "Pelagic Standard", kind: "design system", verb: "designed" } };
  const other = { firstName: "Kai", signature: { entity: "Sundial Custody", kind: "library", verb: "built" } };
  assert.deepEqual(gradeIcebreaker("Your Pelagic Standard design system is lovely.", owner, other), ["THEFT"]);
});

// ── round six (2026-07-27, the dense reverse bucket) ─────────────────────────
// The list held the English "branding" but not the Slovak gerund the model
// actually writes, so a correct opener — the recipient really did the branding,
// the sender really hosts the podcast — was graded THEFT, while the same claim
// with a preposition was left alone. Both directions are pinned, because the
// narrowness of SERVICE_NOUN is load-bearing: widening it far enough to mask a
// real theft would be a worse bug than the one it fixes.
test("round six: a Slovak service gerund is not a claim on the artifact", () => {
  const sender = { signature: { entity: "Salt & Signal" }, firstName: "Gideon" };
  const recipient = { signature: { entity: "Ferrous Tideline" }, firstName: "Dmitri" };
  for (const good of [
    "Ahoj Dmitri – som kryptografka a tvoje brandovanie Salt & Signal ma velmi zaujalo.",
    "Tvoje brandovania Salt & Signal su presne ten smer, ktorym chcem ist.",
    "Tvoja praca na Salt & Signal ma velmi zaujala.",
    // The locative. Same word, and it was still graded THEFT after the first fix,
    // which is why SERVICE_NOUN now matches this family by stem + case ending.
    "Ahoj, pocula som o tvojom brandovani Salt & Signal – to je moj podcast!",
    "Zaujalo ma tvoje spracovanie Salt & Signal.",
  ]) {
    assert.deepEqual(gradeIcebreaker(good, sender, recipient), [], `should be clean: ${good}`);
  }
});

test("round six does not mask a real theft of the same artifact", () => {
  const sender = { signature: { entity: "Salt & Signal" }, firstName: "Gideon" };
  const recipient = { signature: { entity: "Ferrous Tideline" }, firstName: "Dmitri" };
  for (const bad of [
    "Ahoj Dmitri, pocuvam tvoj podcast Salt & Signal a rozmyslam nad epizodou.",
    "Tvoja relacia Salt & Signal je skvela.",
    "Vidim, ze si vytvoril Salt & Signal – ja ho moderujem.",
  ]) {
    assert.ok(
      gradeIcebreaker(bad, sender, recipient).includes("THEFT"),
      `should still be THEFT: ${bad}`,
    );
  }
});

// ── round seven (2026-07-27): the rule was inverted, so pin BOTH directions ───
// `governs()` used to claim the artifact unless an intervening noun was on a
// hand-kept SERVICE list. Service words are an open class the model invents per
// language — one Slovak run needed "branding", "brandovanie", "brandovaní" and
// "brandáž" — so the default now blocks unless the intervening noun is a CATEGORY
// of the artifact. These are real openers from the dense reverse run, hand-read
// and classified before the rule changed.
const DENSE_SENDER = { signature: { entity: "Sundial Custody" }, firstName: "Rosa" };
const DENSE_RECIP = { signature: { entity: "Kestrel Mesh" }, firstName: "Jonah" };

test("round seven: a SERVICE the recipient performed is never a claim on the artifact", () => {
  for (const good of [
    "Casimir, videl som tvoju brandaz Sundial Custody – skvela. Mam kniznicu, ktora potrebuje partnera.",
    "Ahoj Jonah, pocula som o tvojom brandovani Sundial Custody – to je moja kniznica!",
    "Zaujala ma tvoja vizualna praca na Sundial Custody.",
  ]) {
    assert.deepEqual(gradeIcebreaker(good, DENSE_SENDER, DENSE_RECIP), [], `should be clean: ${good}`);
  }
});

test("round seven: a CATEGORY noun still carries the claim to the artifact", () => {
  // The inversion must not buy its false-positive fix with blindness: these are
  // the shapes the prod failure actually took.
  for (const bad of [
    "Ahoj Kenji, tvoja Sundial Custody kniznica je presne to, co potrebujem.",
    "Ahoj Kenji, tvoja Sundial Custody je skvela.",
    "Pocul som o tvojej kniznici Sundial Custody.",
    "Tvoj projekt Sundial Custody ma zaujal.",
  ]) {
    assert.ok(
      gradeIcebreaker(bad, DENSE_SENDER, DENSE_RECIP).includes("THEFT"),
      `should be THEFT: ${bad}`,
    );
  }
});

test("round seven: the category list is built from stems, so PLURALS still carry the claim", () => {
  // "Tvoje projekty ako Pelagic Standard" was graded clean because the list held
  // the singular "projekt" and not the plural "projekty" — while being a textbook
  // instance of the failure this benchmark exists to catch: the model lifting the
  // word "project" out of the recipient's `hot project` line and handing them the
  // sender's work. Slovak inflects for case AND number, so surface-form lists are
  // not viable; PRODUCT_NOUN is stem-built for this reason.
  const sender = { signature: { entity: "Pelagic Standard" }, firstName: "Ines" };
  const recipient = { signature: { entity: "Kestrel Mesh" }, firstName: "Jonah" };
  for (const bad of [
    "Tvoje projekty ako Pelagic Standard ukazuju, ze rozumies systemom.",
    "Tvoje aplikacie ako Pelagic Standard su presne to, co hladam.",
    "Zaujali ma tvoje knihy ako Pelagic Standard.",
  ]) {
    assert.ok(gradeIcebreaker(bad, sender, recipient).includes("THEFT"), `should be THEFT: ${bad}`);
  }
});
