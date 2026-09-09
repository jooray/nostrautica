import { describe, it, expect, afterEach } from "vitest";
import { i18n } from "./i18n.svelte.js";
import { messages, LOCALES, type Locale } from "./messages.js";

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
 * (i18n.test.ts already proves key-set parity and that every `.one` family has
 * `.few`/`.many` in sk and cs; this file is about the specific families this
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
      expect(messages.en, `en ${base}.one`).toHaveProperty(`${base}.one`);
      expect(messages.en, `en ${base}.many`).toHaveProperty(`${base}.many`);
      for (const loc of ["sk", "cs"] as const) {
        for (const form of ["one", "few", "many"] as const) {
          expect(messages[loc], `${loc} ${base}.${form}`).toHaveProperty(`${base}.${form}`);
        }
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
    // English needs only two: 1 vs everything else (0 included, per pluralCategory).
    expect(shape("en", 1)).not.toBe(shape("en", 3));
    expect(shape("en", 3)).toBe(shape("en", 9));
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
    // "Commit" is a loanword in both and deliberately stays as-is; the rest must
    // actually differ from English, or they were never translated.
    for (const key of keys.filter((k) => k !== "settings.about.commit")) {
      expect(messages.sk[key], `sk ${key}`).not.toBe(messages.en[key]);
      expect(messages.cs[key], `cs ${key}`).not.toBe(messages.en[key]);
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
