import { describe, it, expect, afterEach } from "vitest";
import { i18n } from "./i18n.svelte.js";
import { messages, LOCALES, type Locale } from "./messages.js";
import { tc, tcp } from "./i18n.svelte.js";

/**
 * Catalog checks for the counted strings that used to interpolate `{n}` into a
 * single fixed sentence.
 *
 * English can get away with that when the noun happens not to inflect, or by
 * writing "action(s)" — which is what `me.logout.warnUnsent` did. Slovak and
 * Czech cannot: they need three forms (1 / 2–4 / 5+), the parenthetical device
 * has no equivalent in either language, and the sk/cs strings were all written
 * in the 5+ form, so "Máte 1 neodoslaných akcií" was what a user with one queued
 * item actually read.
 *
 * German and Spanish inflect the noun too, but with two forms rather than three,
 * so they are checked against the same families with the en-shaped rule.
 *
 * (i18n.test.ts already proves key-set parity and that every `.one` family has
 * the forms its locale needs; this file is about the specific families this
 * change introduced, and about the values being genuinely different per form.)
 */

const PLURAL_FAMILIES = [
  "me.logout.warnUnsent",
  "nav.matches.new",
  "dm.unread",
  "event.attendeesSection.count",
  "outbox.retries",
  "post.editor.bytes",
] as const;

afterEach(() => {
  i18n.locale = "en";
  i18n.explicit = false;
});

describe("counted strings use plural families", () => {
  it("every converted key has the forms its locale needs", () => {
    for (const base of PLURAL_FAMILIES) {
      for (const loc of ["en", "de", "es"] as const) {
        expect(messages[loc], `${loc} ${base}.one`).toHaveProperty(`${base}.one`);
        expect(messages[loc], `${loc} ${base}.many`).toHaveProperty(`${base}.many`);
      }
      for (const loc of ["sk", "cs"] as const) {
        for (const form of ["one", "few", "many"] as const) {
          expect(messages[loc], `${loc} ${base}.${form}`).toHaveProperty(`${base}.${form}`);
        }
      }
    }
  });

  it("the two-form locales actually distinguish singular from plural", () => {
    // German and Spanish inflect the counted noun just as English does
    // ("1 Teilnehmender" / "3 Teilnehmende", "1 asistente" / "3 asistentes"),
    // so `.one` and `.many` filled with the same sentence is the same bug the
    // sk/cs check below catches, one form shallower.
    for (const base of PLURAL_FAMILIES) {
      for (const loc of ["de", "es"] as const) {
        const one = messages[loc][`${base}.one` as keyof (typeof messages)[typeof loc]];
        const many = messages[loc][`${base}.many` as keyof (typeof messages)[typeof loc]];
        expect(one, `${loc} ${base} has identical one/many`).not.toBe(many);
      }
    }
  });

  it("sk/cs actually distinguish the three forms (not three copies of one)", () => {
    // The failure mode this catches is a translator filling `.one` and `.few`
    // with the `.many` string to satisfy the parity test — which reintroduces
    // exactly the bug, silently.
    for (const base of PLURAL_FAMILIES) {
      for (const loc of ["sk", "cs"] as const) {
        const forms = (["one", "few", "many"] as const).map(
          (f) => messages[loc][`${base}.${f}` as keyof (typeof messages)[typeof loc]],
        );
        expect(new Set(forms).size, `${loc} ${base} has duplicate forms`).toBe(3);
      }
    }
  });

  it("picks the right form for 1 / 2–4 / 5+ in each locale", () => {
    const rendered = (loc: Locale, n: number) => {
      i18n.locale = loc;
      return i18n.tp("me.logout.warnUnsent", n);
    };
    // Compare the SENTENCE, with the interpolated count blanked out — the count
    // always differs, and it's the wording around it that the plural form picks.
    const shape = (loc: Locale, n: number) => rendered(loc, n).replace(String(n), "#");
    // The count is always interpolated, whichever form wins.
    for (const loc of LOCALES) {
      for (const n of [1, 3, 9]) expect(rendered(loc, n)).toContain(String(n));
    }
    // Slovak: singular / 2–4 / genitive plural are three different sentences.
    expect(shape("sk", 1)).not.toBe(shape("sk", 3));
    expect(shape("sk", 3)).not.toBe(shape("sk", 9));
    expect(shape("cs", 1)).not.toBe(shape("cs", 3));
    expect(shape("cs", 3)).not.toBe(shape("cs", 9));
    // English, German and Spanish need only two: 1 vs everything else
    // (0 included, per pluralCategory).
    for (const loc of ["en", "de", "es"] as const) {
      expect(shape(loc, 1), `${loc} singular vs plural`).not.toBe(shape(loc, 3));
      expect(shape(loc, 3), `${loc} has no separate 2-4 form`).toBe(shape(loc, 9));
    }
  });

  it("no user-facing string contains an em or en dash", () => {
    // The single most reliable tell that a string was drafted by a model rather
    // than written. All 3500 strings here were dash-free until 2026-09-13, when
    // nine arrived in one day across three languages and had to be hunted back
    // out by hand. Slovak and Czech typography has no em dash at all, so there
    // it is not even a style preference.
    //
    // The en dash stays banned in prose too; ranges in UI copy are written with
    // "to"/"až" or a hyphen. If a genuine numeric range ever needs one, narrow
    // this test to that key rather than deleting it.
    for (const loc of LOCALES) {
      const offenders = Object.entries(messages[loc])
        .filter(([, v]) => typeof v === "string" && /[—–]/.test(v))
        .map(([k]) => k);
      expect(offenders, `${loc} contains a dash that should be punctuation`).toEqual([]);
    }
  });

  it("no string papers over grammatical gender with a bracketed suffix", () => {
    // The Slovak and Czech version of the "(s)" crutch: "prihlásený(á)",
    // "připojen(a)", "uložil(a)". It is not a translation, it is two words in a
    // trench coat, and with formal `vy` it is not even needed — plural agreement
    // ("ste prihlásení") is already gender-neutral and is what people write.
    //
    // German and Spanish have the same crutch in their own shapes:
    // "Teilnehmer(in)", "conectado(a)", "asistente(a)". Both have an honest way
    // out (a neutral role noun like "Teilnehmende", an epicene noun like
    // "asistente", or a rephrase to du/tú), so the bracket is never the answer.
    const bracketed = /\((?:a|á|ka|y|i|in|e|r|os|as)\)/;
    for (const loc of LOCALES) {
      const offenders = Object.entries(messages[loc])
        .filter(([, v]) => typeof v === "string" && bracketed.test(v))
        .map(([k]) => k);
      expect(offenders, `${loc} uses a bracketed gender suffix`).toEqual([]);
    }
  });

  it("no string uses gender-star, gender-colon or an inclusive-ending hack", () => {
    // The other way a translator dodges the same problem: "Teilnehmer*innen",
    // "Teilnehmer:innen", "TeilnehmerInnen", "asistent@s", "todxs". Screen
    // readers mangle all of them, and the repo owner has not opted into
    // gendered orthography, so the neutral noun is the house style.
    // Deliberately narrow. A rule broad enough to catch every possible spelling
    // would also catch ordinary words ("Index", "fix") and every email address,
    // and a test that cries wolf gets deleted rather than fixed.
    const hacks = [
      /[a-zä-üß][*:_]innen/i, // Teilnehmer*innen / Teilnehmer:innen / Teilnehmer_innen
      /[a-zä-üß]Innen\b/, // TeilnehmerInnen (inner capital)
      /[a-zá-úñ]@s\b/, // asistent@s, amig@s
    ];
    for (const loc of LOCALES) {
      const offenders = Object.entries(messages[loc])
        .filter(([, v]) => typeof v === "string" && hacks.some((re) => re.test(v)))
        .map(([k]) => k);
      expect(offenders, `${loc} uses an inclusive-language typography hack`).toEqual([]);
    }
  });

  it("no counted string still uses the English '(s)' device", () => {
    // "action(s)" reads as a placeholder even in English and is untranslatable
    // into either Slavic locale — there is no sk/cs construction that means it.
    for (const loc of LOCALES) {
      const offenders = Object.entries(messages[loc])
        .filter(([, v]) => typeof v === "string" && /\(s\)/.test(v))
        .map(([k]) => k);
      expect(offenders, `${loc} still uses "(s)"`).toEqual([]);
    }
  });
});

describe("strings that were hardcoded English in the UI", () => {
  it("Settings' About labels are translated in every locale", () => {
    // These five sat in an array literal inside Settings.svelte rather than in
    // markup, which is how they stayed English for sk/cs users this long.
    const keys = [
      "settings.about.release",
      "settings.about.app",
      "settings.about.protocol",
      "settings.about.commit",
      "settings.about.built",
    ] as const;
    for (const key of keys) {
      for (const loc of LOCALES) expect(messages[loc][key]).toBeTruthy();
    }
    // "Commit" is a loanword everywhere and deliberately stays as-is. In sk and
    // cs the other four must differ from English or they were never translated.
    for (const key of keys.filter((k) => k !== "settings.about.commit")) {
      expect(messages.sk[key], `sk ${key}`).not.toBe(messages.en[key]);
      expect(messages.cs[key], `cs ${key}`).not.toBe(messages.en[key]);
    }
    // German and Spanish get a narrower check on purpose: "App" is the German
    // word for an app and "Release" is what German developers say, so asserting
    // they differ from English would be asserting a mistranslation. "Protocol"
    // and "Built" have real equivalents in both, and those are what this checks.
    for (const key of ["settings.about.protocol", "settings.about.built"] as const) {
      expect(messages.de[key], `de ${key}`).not.toBe(messages.en[key]);
      expect(messages.es[key], `es ${key}`).not.toBe(messages.en[key]);
    }
  });

  it("the direct-messages row has its own label, distinct from the Chat tab", () => {
    // EventMore's row (direct messages) and EventNav's tab (the event group
    // chat) both rendered t("nav.chat") — one label on two destinations.
    for (const loc of LOCALES) {
      expect(messages[loc]["nav.messages"]).toBeTruthy();
      expect(messages[loc]["nav.messages"]).not.toBe(messages[loc]["nav.chat"]);
    }
  });

  it("the roster's three empty states are three separate strings", () => {
    const keys = [
      "attendees.empty.notApproved",
      "attendees.empty.none",
      "attendees.empty.unreachable",
    ] as const;
    for (const loc of LOCALES) {
      const values = keys.map((k) => messages[loc][k]);
      expect(new Set(values).size, `${loc} empty states`).toBe(3);
    }
    // The old conflated string is gone, not merely shadowed.
    expect(messages.en).not.toHaveProperty("attendees.empty");
  });
});

/**
 * Primal must not be recommended as a signer (2026-09-09, reported from an
 * iPhone).
 *
 * Its built-in signer connects, reports success, and then silently refuses the
 * addressable/custom event kinds this whole app is built on. So it is not a
 * signer that might be missing, it is one that appears to work and then loses
 * everything the user does. Naming it in the button was steering people into
 * that, and on iOS the OS often routes the nostrconnect:// link there anyway
 * when both it and a working signer are installed.
 *
 * Primal stays recommended as a READING client (`Me.svelte`'s "take your identity
 * anywhere" list, the guides): pasting an nsec into it to see your feed is a
 * different thing and works fine. This is only about signing.
 */
describe("signer recommendations", () => {
  const SIGNER_KEYS = ["signin.remote.openSigner", "signin.remote.hint"] as const;

  it("never names Primal in a sign-in signer suggestion, in any language", () => {
    for (const [lang, table] of Object.entries(messages)) {
      for (const key of SIGNER_KEYS) {
        expect(`${lang}:${key}:${(table as Record<string, string>)[key]}`).not.toMatch(/Primal/);
      }
    }
  });

  it("explains the Primal trap somewhere the user can find it, in every language", () => {
    for (const [lang, table] of Object.entries(messages)) {
      const trouble = (table as Record<string, string>)["signin.trouble.primal"];
      expect(`${lang}: ${trouble ?? ""}`).toMatch(/Primal/);
    }
  });
});

describe("community wording (tc / tcp)", () => {
  it("falls back to the event string when a key has no community variant", () => {
    // The point of the helper: only the strings that say "event" or "attendee"
    // out loud need a second version, and every other string in the app keeps
    // working untouched. If this ever throws or returns the key, adding a
    // community variant becomes an all-or-nothing migration of 159 strings.
    i18n.locale = "sk";
    expect(tc("attendees.title", true)).toBe(tc("attendees.title", false));
    expect(tc("attendees.title", true)).toBe(messages.sk["attendees.title"]);
  });

  it("uses the community wording where one exists, in every locale", () => {
    for (const loc of LOCALES) {
      i18n.locale = loc;
      const event = tc("attendees.rosterLabel", false);
      const community = tc("attendees.rosterLabel", true);
      expect(community).toBeTruthy();
      expect(community, `${loc} roster label`).not.toBe(event);
    }
  });

  it("keeps the plural family intact for the community count", () => {
    // Slovak and Czech need one/few/many for members exactly as they do for
    // attendees; a community variant that defined only `.many` would silently
    // render "5 členov" for a single member.
    for (const loc of LOCALES) {
      i18n.locale = loc;
      for (const n of [1, 3, 9]) {
        const s = tcp("attendees.count", true, n);
        expect(s, `${loc} n=${n}`).toContain(String(n));
        expect(s, `${loc} n=${n} should not be the attendee wording`).not.toBe(
          tcp("attendees.count", false, n),
        );
      }
      // sk/cs distinguish 1 / 2-4 / 5+; en, de and es only 1 / other.
      const shape = (n: number) => tcp("attendees.count", true, n).replace(String(n), "#");
      expect(shape(1), `${loc} singular`).not.toBe(shape(9));
      if (loc === "sk" || loc === "cs") {
        expect(shape(3), `${loc} few`).not.toBe(shape(9));
      }
    }
  });

  it("never silently shows English to a Slovak reader when a variant is missing", () => {
    // `has` checks English on purpose: a variant is added in all three languages
    // together, so a missing one means the KEY does not exist, not that a
    // translation lagged. Falling back to the Slovak event wording beats
    // falling through to an English community string.
    i18n.locale = "sk";
    expect(tc("attendees.decrypting", true)).toBe(messages.sk["attendees.decrypting"]);
  });
});
