/**
 * Objective grading for match icebreakers. No LLM judge, no human rubric — every
 * check below is a hard pass/fail against a known-owner artifact, which is what
 * makes this cheap enough to run on every prompt change.
 *
 * What we are measuring, and why each check exists (all three are real prod
 * failures from 2026-07-24/25, not hypotheticals):
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
 * Reported separately: THEFT/FALSE CLAIM hinge on an invented proper noun with
 * exactly one owner, so they are the hard number, while BRIEFING is heuristic and
 * can misfire. Keeping them apart means a soft signal cannot contaminate the hard
 * one. "Hard" does NOT mean self-evidently correct: four separate rounds of false
 * positives have come out of this file, one of which flagged 17 rows of which 17
 * were correct openers. Every rule here that looks like it could be simpler was
 * made complicated by a specific row of real model output, pinned in
 * icebreaker-grade.test.mjs. Read the flagged rows before quoting a number.
 *
 * 2026-07-25: the grader was English-only, and the failure that reached
 * production was Slovak — an English-only grader reported 0% attribution errors
 * for a prompt that was inverting every icebreaker for one candidate at a live
 * Slovak event. Slovak/Czech need three things English does not:
 *  - possessives inflect (tvoj/tvoja/tvojich/môj/mojej…), so a word list beats a
 *    two-token check, and `\b` is useless around á/í/ô so the boundaries are
 *    `\p{L}` lookarounds;
 *  - ownership is routinely stated with a VERB and no possessive at all
 *    ("počul som, že si vytvoril Nostrauticu" = "I heard you created Nostrautica"),
 *    which was one of the three real prod errors;
 *  - the artifact NAME itself inflects ("Nostrautica" → "Nostrauticu",
 *    "Krotitelia" → "Krotiteľov"), so an exact substring match silently finds
 *    nothing and grades the icebreaker clean.
 */

/** Characters of context before an entity mention that can carry its possessive. */
const WINDOW = 70;

// ── possessives ───────────────────────────────────────────────────────────────
// A real POSSESSIVE, never a bare pronoun. Requiring just a nearby "I"/"you"
// over-fires badly: "I read about The Vellum Cipher" is someone admiring the
// other person's work, not claiming it — the first benchmark run scored seven of
// those as false claims and the number was meaningless until this was tightened.
// Same reason "má" (Czech "my", also "he/she HAS") is deliberately absent below:
// "Marianna má knihu X" is "Marianna has the book", not a claim of authorship.

const SECOND_POSSESSIVES = [
  // English
  "your",
  // Slovak — full declension of tvoj + the polite vaš- forms
  "tvoj", "tvoja", "tvoje", "tvojho", "tvojmu", "tvojom", "tvojím", "tvojim", "tvojich",
  "tvoju", "tvojej", "tvojou", "tvoji", "tvojimi",
  "váš", "vaša", "vaše", "vášho", "vašmu", "vašom", "vaším", "vašim", "vašich", "vašu",
  "vašej", "vašou",
  // Czech
  "tvůj", "tvá", "tvé", "tvého", "tvému", "tvém", "tvým", "tvých", "tvou", "tvojí",
  "vašeho", "vašemu", "vaší", "vaši",
];

const FIRST_POSSESSIVES = [
  // English
  "my",
  // Slovak — note môjho/môjmu keep the ô; a list without them read
  // "čo môjmu Vetroplachu chýba" as the sender disowning their own app
  "môj", "môjho", "môjmu", "moja", "moje", "mojho", "mojmu", "mojom", "mojím", "mojim",
  "mojich", "mojimi", "moju", "mojej", "mojou", "moji",
  // Czech ("má"/"mě" omitted on purpose — homonyms of common verb/pronoun forms)
  "můj", "mé", "mého", "mému", "mém", "mým", "mých", "mou", "mojí", "moji",
];

/** `\b` breaks on á/ô/ě, so word edges are Unicode-letter lookarounds. */
function wordListRe(words) {
  const alt = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(?<!\\p{L})(?:${alt})(?!\\p{L})`, "giu");
}
const SECOND_POSS_RE = wordListRe(SECOND_POSSESSIVES);
const FIRST_POSS_RE = wordListRe(FIRST_POSSESSIVES);

// ── "you made it" / "I made it" without a possessive ──────────────────────────
// Slavic ownership is normally a verb, not a possessive: "si vytvoril X" /
// "napísal si X" / "som autorom X" — one of the three real prod failures had no
// possessive anywhere. Whether the verb reaches the artifact is left to governs()
// below, the same test the possessives get: "you created Nostrautica" is a claim,
// "I made a list of questions about Kestrel Mesh" is not.
//
// CONSUMPTION verbs (read/heard/saw, čítal/videl) are deliberately absent —
// reading someone's book is admiration, and "čítal si Krotiteľov entropie?" is a
// perfectly correct opener from the author.

/** Creation participles (sk/cs), stem + optional -a/-i/-o gender/plural ending. */
const MADE_SLAVIC =
  "(?:vytvoril|stvoril|napísal|napsal|urobil|udělal|spravil|postavil|vybudoval|vyvinul|" +
  "založil|naprogramoval|nakreslil|navrhol|navrhl|nahral|nahrál|nakrútil|natočil|vydal|" +
  "zostavil|sestavil|vyrobil|vymyslel|zložil|složil)(?:a|i|o|y)?";
/** "…som autorom/tvorcom…" — an ownership claim with no verb at all. */
const AUTHOR_SLAVIC = "(?:autor|autorka|autorom|autorkou|autorem|tvorca|tvorcom|tvůrce|tvůrcem)";

const MADE_EN =
  "(?:wrote|written|built|made|created|designed|authored|founded|recorded|directed|" +
  "published|shipped|compiled|invented)";
/**
 * "I'm building X" is the commonest first-person claim in these openers, and
 * without it the nearest-claim comparison loses to a "your" earlier in the
 * sentence: "Your Kestrel Mesh sounds fascinating — I'm building Handbasket
 * Rails" is a correct opener that graded as THEFT of the sender's own app.
 */
const MAKING_EN =
  "(?:building|writing|making|designing|creating|recording|running|hosting|maintaining|" +
  "publishing|shipping|putting together)";
/**
 * Simple present, first person: "I host Salt & Signal", "I run X". Missing this
 * cost a false THEFT on the sender's OWN podcast, because the only claim the
 * grader could see was a "your" in the previous clause.
 */
const HAVE_EN = "(?:host|run|write|build|make|design|maintain|publish|record|own|lead)";
/** Slavic 1st-person present: "mám X", "vyvíjam X", "pracujem na X", "vediem X". */
const HAVE_SLAVIC =
  "(?:mám|máme|vlastním|vediem|vedu|vyvíjam|vyvíjím|robím|dělám|tvorím|tvořím|staviam|stavím|" +
  "budujem|buduji|píšem|píši|vydávam|vydávám|prevádzkujem|provozuji|pracujem\\s+na|pracuji\\s+na|" +
  "vyrábam|vyrábím|spravujem|spravuji|moderujem|nahrávam)";

const SECOND_MADE_RES = [
  // English: "you built X", "the novel you wrote, X", "you're the author of X"
  new RegExp(`(?<!\\p{L})you(?:'ve|'ll| have| had)?\\s+(?:also\\s+|just\\s+)?${MADE_EN}`, "giu"),
  new RegExp(`(?<!\\p{L})you(?:'re| are)\\s+the\\s+(?:author|creator|writer|maker|founder)(?:\\s+of)?`, "giu"),
  // Slovak/Czech: "si vytvoril X", "vytvoril si X", "si autorom X"
  new RegExp(`(?<!\\p{L})(?:si|jsi)\\s+(?:\\p{L}+\\s+){0,1}${MADE_SLAVIC}`, "giu"),
  new RegExp(`(?<!\\p{L})${MADE_SLAVIC}\\s+(?:si|jsi)`, "giu"),
  new RegExp(`(?<!\\p{L})(?:si|jsi)\\s+${AUTHOR_SLAVIC}`, "giu"),
];

const FIRST_MADE_RES = [
  new RegExp(`(?<!\\p{L})I(?:'ve| have| had)?\\s+(?:also\\s+|just\\s+)?${MADE_EN}`, "gu"),
  new RegExp(`(?<!\\p{L})I(?:'m| am|'ve been| have been)\\s+(?:also\\s+|just\\s+|currently\\s+)?${MAKING_EN}`, "gu"),
  new RegExp(`(?<!\\p{L})I(?:'m| am)\\s+the\\s+(?:author|creator|writer|maker|founder)(?:\\s+of)?`, "gu"),
  new RegExp(`(?<!\\p{L})(?:som|jsem)\\s+(?:\\p{L}+\\s+){0,1}${MADE_SLAVIC}`, "giu"),
  new RegExp(`(?<!\\p{L})${MADE_SLAVIC}\\s+(?:som|jsem)`, "giu"),
  new RegExp(`(?<!\\p{L})(?:som|jsem)\\s+${AUTHOR_SLAVIC}`, "giu"),
  // 1st-person present: "tvorím nástroj X", "ja mám X", "pracujem na X". Every
  // one of these turned up in real Slovak output as a CORRECT self-claim that the
  // grader scored as theft of the sender's own artifact.
  new RegExp(`(?<!\\p{L})(?:ja\\s+|já\\s+)?${HAVE_SLAVIC}`, "giu"),
  new RegExp(`(?<!\\p{L})I\\s+${HAVE_EN}`, "gu"),
];

/**
 * Claims that sit AFTER the mention. Anchored to the very start of the trailing
 * window, so they are unambiguously about the entity: "X is yours", "X, ktorú si
 * vytvoril". Unanchored scanning here would misread "I wrote X — I hear you built
 * Y" as a claim on X.
 */
// "X is yours"/"X je tvoja" is a claim; "X is your place" is not — that is an
// invitation ("Vantablack Kitchen is your place", written by the person who runs
// it, was the one false positive the sharpened grader produced on the saved
// 2026-07-24 run). So a trailing possessive only counts when it stands alone,
// i.e. ends the clause instead of governing a following noun.
const CLAUSE_END = "\\s*(?:[.!?,;:–—]|$)";
const SECOND_AFTER_RES = [
  /^\s*(of|,)?\s*yours\b/i,
  new RegExp(`^[\\s,–—-]*(?:that|which|ktorý|ktorá|ktoré|ktorú|ktorého|který|kterou|kterého)\\s+(?:si|jsi|you)\\b`, "iu"),
  new RegExp(`^[\\s,–—-]*(?:je|are|is)\\s+(?:${SECOND_POSSESSIVES.join("|")})(?!\\p{L})${CLAUSE_END}`, "iu"),
];
const FIRST_AFTER_RES = [
  /^\s*(of|,)?\s*mine\b/i,
  new RegExp(`^[\\s,–—-]*(?:je|is)\\s+(?:${FIRST_POSSESSIVES.join("|")})(?!\\p{L})${CLAUSE_END}`, "iu"),
];

// ── inflection-tolerant entity matching ───────────────────────────────────────

/**
 * Strip diacritics ONE CHARACTER AT A TIME so the result is index-aligned with
 * the input: NFD on the whole string expands á into two code units and every
 * match index after it would be wrong.
 */
function deaccent(s) {
  let out = "";
  for (const ch of s) {
    const base = ch.normalize("NFD").replace(/\p{M}+/gu, "");
    out += base.length === 1 ? base : ch;
  }
  return out.toLowerCase();
}

/**
 * Slovak declines the artifact name itself: "Nostrautica" → "Nostrauticu",
 * "Krotitelia entropie" → "Krotiteľov entropie" (the ľ is why this runs on
 * de-accented text). So each word keeps a stem and accepts a different ending.
 * Only used when the exact match fails, so English grading is untouched.
 */
function stemRe(entity) {
  const parts = deaccent(entity)
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (w.length >= 6) return `${esc(w.slice(0, w.length - 2))}\\p{L}{0,4}`;
      if (w.length >= 4) return `${esc(w)}\\p{L}{0,3}`;
      return esc(w);
    });
  return new RegExp(`(?<!\\p{L})${parts.join("\\s+")}(?!\\p{L})`, "iu");
}

/** First mention of `entity`, exact if possible, else inflected. */
function findEntity(text, entity) {
  const i = text.toLowerCase().indexOf(entity.toLowerCase());
  if (i !== -1) return { index: i, end: i + entity.length };
  const m = stemRe(entity).exec(deaccent(text));
  return m ? { index: m.index, end: m.index + m[0].length } : null;
}

/**
 * Trim the pre-entity window back to the start of the sentence the mention is in.
 * A possessive one sentence earlier does not govern this noun: "Ahoj Jonah — tvoja
 * práca na Kestrel Mesh znie skvele. Mám Handbasket Rails…" is correct on both
 * counts, and without this cut the "tvoja" from the previous sentence scored the
 * sender's own app as stolen. Requiring whitespace after the stop keeps
 * "hackyourself.io" (and any other dotted name) from reading as a boundary.
 */
function sameSentence(before) {
  const m = [...before.matchAll(/[.!?;]\s+/g)].pop();
  return m ? before.slice(m.index + m[0].length) : before;
}

// ── does a claim actually reach the artifact? ─────────────────────────────────
// The 2026-07-25 trap runs flagged seventeen icebreakers and every single one was
// a false positive of one shape: the possessive belonged to a DIFFERENT noun.
// "your branding for The Vellum Cipher", "tvoja práca na Brambleway", "tvoja
// špecializácia na UX je presne to, čo Vetroplach potrebuje" — the branding, the
// work and the expertise really are the recipient's; the artifact is still the
// sender's. A possessive binds to the noun phrase it opens, so it only claims the
// artifact when the artifact is the head of that phrase.
//
// This is the check that decides it, and it has to keep the real prod failure
// "o tvojich kurzoch na hackyourself.io" flagged: there a preposition intervenes
// too, but the intervening noun ("kurzoch") is a PRODUCT of whoever owns the site,
// not a service rendered to it. Hence the small product-noun allowlist below —
// without it the rule is either blind to the prod failure or blind to the trap.
const GAP_MAX_WORDS = 3;
const PREPOSITIONS = new Set([
  "of", "on", "for", "in", "with", "to", "at", "about", "from", "like", "into", "behind",
  "na", "pre", "o", "s", "so", "v", "vo", "k", "ku", "do", "od", "z", "zo", "po", "pri",
  "za", "u", "pro", "ke", "se", "ve", "ze",
]);
/**
 * A noun that names WHAT THE ARTIFACT IS — its category — as opposed to a service
 * somebody performed on it.
 *
 * This list is the hinge of `governs()`, and which way the hinge swings was got
 * wrong for six rounds. The rule used to be "an intervening noun keeps the claim
 * UNLESS it is a known service word", with a hand-maintained SERVICE_NOUN list.
 * That default is backwards: service words are an open class, invented freshly by
 * the model in whatever language it is writing, so every run turned up another one
 * and every one was a false positive that inflated the error count. In a single
 * Slovak run this list needed "branding", then "brandovanie", then the locative
 * "brandovaní", then "brandáž" — four spellings of one idea, each discovered by
 * hand-reading flagged rows, each having already corrupted a published number.
 *
 * So the default is inverted: an intervening noun BLOCKS the claim unless it is a
 * category from this list. Categories are a closed class — the kinds of thing a
 * person makes — and they are enumerable from the fixture's own `kind` values plus
 * ordinary synonyms. The failure mode flips from over-counting (a correct opener
 * graded as theft, which is what has repeatedly produced wrong conclusions) to
 * under-counting (a real theft missed because the model reached for an unusual
 * category word), which at least fails in the direction of not claiming a fix.
 *
 * Slovak and Czech inflect, so most entries are stems with their case endings.
 */
// Built from STEMS plus the Slovak/Czech case-and-number endings, not from a list
// of surface forms. Enumerating forms is what let `"Tvoje projekty ako Pelagic
// Standard"` through: the singular "projekt" was listed and the plural "projekty"
// was not, so a textbook instance of the failure this benchmark exists to catch —
// the model lifting "project" out of the recipient's `hot project 🔥` line and
// handing them the sender's work — was graded clean.
const SK_END = "(|a|u|e|y|i|ou|om|om|och|ov|ami|mi|ach|iach|ie|iu|ia|om)";
const NOUN_STEMS = [
  // content published under an artifact (keeps "o tvojich kurzoch na X" flagged)
  "kurz", "epizod", "clank", "clanok", "verzi", "kapitol", "workshop", "newsletter", "blog", "post",
  // artifact categories
  "knih", "kniz", "roman", "album", "nahravk", "podcast", "relaci", "serial", "seri",
  "dokument", "film", "vyskum", "studi", "aplikaci", "appk", "program", "projekt",
  "kniznic", "sad", "nastroj", "dataset", "index", "atlas", "map", "priestor", "klub",
  "konferenci", "festival", "podujati", "fond", "grant", "imprint", "vydavatelstv",
  "kurikul", "metodik", "metod", "penazenk", "protokol", "system", "casopis",
];
const EN_NOUNS = [
  "course", "courses", "episode", "episodes", "article", "articles", "version", "chapter",
  "book", "books", "novel", "novels", "record", "recording", "show", "series", "documentary",
  "research", "paper", "papers", "study", "app", "apps", "programme", "project", "projects",
  "library", "libraries", "crate", "stack", "toolkit", "tool", "tools", "space", "club",
  "conference", "event", "fund", "press", "curriculum", "method", "wallet", "protocol",
  "zine", "album", "podcast", "dataset", "index", "atlas", "map", "maps", "system", "systems",
];
const PRODUCT_NOUN = new RegExp(
  `^(${NOUN_STEMS.map((s) => s + SK_END).join("|")}|${EN_NOUNS.join("|")})$`,
);
/** A finite verb or copula between the two means they are in different phrases. */
const LINKING =
  /^(je|su|nie|bol|bola|boli|byl|byla|is|are|was|were|sounds|looks|needs|feels|potrebuje|chyba|chybi|ma|maju|have|has|had|would|could|might|znie|vyzera)$/;
/**
 * Round FIVE of false positives (2026-07-25, the K=10 reverse run). The same error
 * as round four in two word orders the gap rule could not see, because the
 * intervening noun is the RECIPIENT's service TO the artifact, not the artifact:
 *
 *   "Your Ironwood Assembly branding is fantastic — I founded the conference series"
 *   "ako by tvoja vízia Ironwood Assembly mohla pomôcť môjmu mentorstvu"
 *
 * Both get ownership RIGHT: the recipient really did the branding, the sender really
 * founded the conference. English puts the service noun AFTER the artifact (a
 * compound: head = "branding"), Slovak puts it before with no preposition, which is
 * why neither reached `governs()`'s preposition branch.
 *
 * Deliberately narrow. "design" is NOT here: one persona's artifact IS a design
 * system, so treating it as a service would mask a real theft — the same reason
 * consumption verbs and PRODUCT_NOUN are drawn as tightly as they are. Category
 * nouns ("project", "podcast", "dokument", "album") stay out for the same reason:
 * "your Nightjar Ledger project" and "tvoj podcast Salt & Signal" are real thefts
 * in this very run.
 */
/**
 * Round SIX (2026-07-27, the dense reverse bucket). Same class again, missed for a
 * purely lexical reason: the list carried the English "branding" but not the Slovak
 * gerund it is always translated as. `"tvoje brandovanie Salt & Signal"` — the
 * recipient really did do that branding, and the sender really does host the
 * podcast — was graded THEFT, while `"tvoja práca na Salt & Signal"` (same claim,
 * with a preposition) was correctly left alone.
 *
 * The lesson is not "add a word": every entry here is English-first, so any service
 * noun the model reaches for in Slovak or Czech is a false positive waiting for the
 * run that happens to produce it. The gerund forms below are added with their
 * inflections for that reason.
 */
// The -vanie gerund is matched by STEM, with the full case paradigm
// (-ie/-ia/-iu/-i/-im after deaccenting), not form by form. Listing forms one at a
// time is what let round six through twice in one run: "tvoje brandovanie X" was
// fixed and "o tvojom brandovaní X" — the locative, same word — was still graded
// THEFT ten minutes later. Slovak and Czech inflect these productively, so a list
// of nominatives is a list of future false positives.
const SERVICE_NOUN =
  /^(branding|artwork|rebrand|logo|packaging|identity|visuals|cover|covers|typography|vizia|vizual|identita|obal|logo|praca|prace|specializacia|vision|work|brandingu|brandingom|(brandovan|stvarnen|prevedn|spracovan|vizualizovan)(ie|ia|iu|i|im))$/;

/**
 * Does a claim ending at `gap`'s start govern the artifact that follows it?
 * `gap` is the raw text between the claim and the mention.
 */
function governs(gap) {
  // A trailing COMMA is apposition ("your book, X") and keeps the link. A trailing
  // DASH does not: "I host a podcast too — Salt & Signal sounds fascinating" is two
  // clauses, and treating the dash as apposition read it as the sender claiming the
  // recipient's podcast.
  if (/[–—-]\s*$/.test(gap)) return false;
  const g = gap.replace(/[\s,:]+$/, "").trim();
  if (g === "") return true;
  if (/[,;:—–()]/.test(g)) return false; // a clause boundary sits between them
  const words = deaccent(g).split(/\s+/).filter(Boolean);
  if (words.length > GAP_MAX_WORDS) return false;
  if (words.some((w) => LINKING.test(w))) return false;
  // Something stands between the possessive and the artifact, so the possessive's
  // head is that something, not the artifact. The claim only REACHES the artifact
  // when the intervening noun names what the artifact IS ("tvoj podcast X",
  // "your book X", "o tvojich kurzoch na X") rather than what the other person did
  // to it ("tvoja brandáž X", "your branding for X"). A preposition, when present,
  // bounds the phrase — words after it belong to the artifact's side.
  //
  // Note this is deliberately "some", not "the first word": Slovak stacks
  // adjectives before the head ("tvoja nová kniha X"), and an adjective is neither
  // a category nor a service.
  const prep = words.findIndex((w) => PREPOSITIONS.has(w));
  const head = prep === -1 ? words : words.slice(0, prep);
  return head.some((w) => PRODUCT_NOUN.test(w));
}

/**
 * Rightmost claim in `before` (from any of `res`) that governs what follows it.
 * Non-governing matches are skipped rather than winning the nearest-claim
 * comparison, which is the whole point: an earlier possessive that DOES govern
 * must still be able to win.
 */
function lastGoverning(before, res) {
  let best = -1;
  for (const re of res) {
    re.lastIndex = 0;
    for (const m of before.matchAll(re)) {
      if (m.index > best && governs(before.slice(m.index + m[0].length))) best = m.index;
    }
  }
  return best;
}

/**
 * Whose does this text claim `entity` is? Looks at the run of text leading up to
 * the mention — that is where the possessive sits in every natural phrasing
 * ("your novel X", "tvoja kniha X", "the novel X you wrote").
 * Returns "second" (yours), "first" (mine), or "none".
 * Nearest claim wins, so "I loved your Nightjar Ledger" is second person despite
 * the earlier "I".
 */
export function attributionOf(text, entity) {
  const at = findEntity(text, entity);
  if (!at) return "none";
  const before = sameSentence(text.slice(Math.max(0, at.index - WINDOW), at.index));
  const after = text.slice(at.end, at.end + WINDOW);
  if (SECOND_AFTER_RES.some((re) => re.test(after))) return "second";
  if (FIRST_AFTER_RES.some((re) => re.test(after))) return "first";
  // "Your Ironwood Assembly branding": the artifact is a modifier and the head of
  // the phrase is the service noun after it, so the possessive claims the service.
  // Only POSSESSIVES are suppressed — a stated "you built X branding" would still
  // be a verb claim, and those are read separately below.
  const nextWord = deaccent(after).trim().split(/[\s,.;:!?—–-]+/)[0] ?? "";
  const serviceHead = SERVICE_NOUN.test(nextWord);
  const second = lastGoverning(before, serviceHead ? SECOND_MADE_RES : [SECOND_POSS_RE, ...SECOND_MADE_RES]);
  const first = lastGoverning(before, serviceHead ? FIRST_MADE_RES : [FIRST_POSS_RE, ...FIRST_MADE_RES]);
  if (second === -1 && first === -1) return "none";
  return second > first ? "second" : "first";
}

/**
 * Does this read as a briefing about the pair rather than a message to them?
 * Signals, any one of which is decisive:
 *  - an instruction to the reader to go talk to a third party ("ask her about",
 *    "spýtaj sa jej", "napíš mu")
 *  - the addressee referred to in the THIRD person by name ("Sunny plays bass") —
 *    legitimate vocative use ("Hi Sunny — ...", "Sunny, what would...") is
 *    excluded by requiring a verb rather than punctuation after the name.
 */
const THIRD_PARTY_RES = [
  /\b(ask|tell|grab|find|meet|talk to|reach out to)\s+(her|him|them)\b/i,
  // sk/cs imperatives aimed at a third party. Kept to explicit imperative forms:
  // anything looser trips on ordinary "…s ňou" phrasings inside a real message.
  new RegExp(
    "(?<!\\p{L})(?:spýtaj|opýtaj|zeptej|napíš|napiš|povedz|řekni|nájdi|najdi|stretni|potkej|chyť|" +
      "chytni|osloviť|oslov)\\s+(?:sa\\s+|se\\s+)?(?:jej|ju|ho|mu|jim|im|nich|je|ji)(?!\\p{L})",
    "iu",
  ),
];
const THIRD_PERSON_VERBS =
  "is|was|has|does|studies|plays|works|builds|writes|runs|makes|leads|hosts|designs|maintains|" +
  "founded|wrote|built|" +
  // sk/cs 3rd person: "Pavel robí branding", "Pavel je autorom", "Pavel má knihu"
  "je|bol|byl|má|robí|dělá|pracuje|vytvoril|vytvořil|napísal|napsal|píše|stavia|buduje|vedie|" +
  "vede|spravuje|hostí|navrhol|navrhl|nahral|nahrál|študuje|studuje|učí|tvorí|tvoří";

export function isBriefing(text, candidateFirstName) {
  if (THIRD_PARTY_RES.some((re) => re.test(text))) return true;
  const name = candidateFirstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const thirdPerson = new RegExp(
    `(?<!\\p{L})${name}(?!\\p{L})\\s+(?:also\\s+|just\\s+|currently\\s+)?(?:${THIRD_PERSON_VERBS})(?!\\p{L})`,
    "iu",
  );
  return thirdPerson.test(text);
}

/**
 * Does this text name the artifact at all? Reported alongside the error counts as
 * a validity guard: THEFT/FALSE_CLAIM can only be detected on an icebreaker that
 * mentions a signature artifact, so a language whose openers name them less often
 * scores "clean" for a reason that has nothing to do with the prompt. Without this
 * number a 0% is unreadable.
 */
export function mentionsEntity(text, entity) {
  return findEntity(text, entity) !== null;
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
  // How many rows the hard checks could even fire on (see mentionsEntity).
  const grounded = rows.filter((r) => r.mentionsTarget || r.mentionsCandidate).length;
  const theft = count("THEFT");
  const falseClaim = count("FALSE_CLAIM");
  const briefing = count("BRIEFING");
  const clean = rows.filter((r) => r.violations.length === 0).length;
  const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  return {
    total,
    grounded,
    groundedPct: pct(grounded),
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
