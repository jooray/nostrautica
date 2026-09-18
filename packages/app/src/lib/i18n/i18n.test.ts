import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { i18n, pluralCategory, langFromHash } from "./i18n.svelte.js";
import { messages, LOCALES, type Locale } from "./messages.js";

describe("i18n interpolation", () => {
  it("substitutes {name} placeholders", () => {
    i18n.set("en");
    expect(i18n.t("join.title", { title: "DevConf" })).toBe("Join DevConf");
  });

  it("leaves unknown placeholders intact", () => {
    i18n.set("en");
    expect(i18n.t("join.title", {})).toContain("{title}");
  });

  it("translates with params in Slovak", () => {
    i18n.set("sk");
    expect(i18n.t("join.title", { title: "DevConf" })).toBe("Pripojiť sa: DevConf");
    i18n.set("en");
  });

  it("translates with params in Czech", () => {
    i18n.set("cs");
    expect(i18n.t("join.title", { title: "DevConf" })).toBe("Připojit se: DevConf");
    i18n.set("en");
  });
});

describe("plural categories", () => {
  it("english: 1 vs many", () => {
    expect(pluralCategory("en", 1)).toBe("one");
    expect(pluralCategory("en", 0)).toBe("many");
    expect(pluralCategory("en", 5)).toBe("many");
  });

  it("slovak: 1 / 2-4 / 5+", () => {
    expect(pluralCategory("sk", 1)).toBe("one");
    expect(pluralCategory("sk", 2)).toBe("few");
    expect(pluralCategory("sk", 4)).toBe("few");
    expect(pluralCategory("sk", 5)).toBe("many");
    expect(pluralCategory("sk", 0)).toBe("many");
  });

  it("czech: 1 / 2-4 / 5+", () => {
    expect(pluralCategory("cs", 1)).toBe("one");
    expect(pluralCategory("cs", 2)).toBe("few");
    expect(pluralCategory("cs", 4)).toBe("few");
    expect(pluralCategory("cs", 5)).toBe("many");
    expect(pluralCategory("cs", 0)).toBe("many");
  });

  it("german and spanish: 1 vs many, never few", () => {
    // Both fall through pluralCategory's default branch. Asserted rather than
    // assumed, because a `.few` key added to either catalog would be dead
    // weight that tp() can never select, and nothing else would catch it.
    for (const loc of ["de", "es"] as const) {
      expect(pluralCategory(loc, 1)).toBe("one");
      expect(pluralCategory(loc, 0)).toBe("many");
      expect(pluralCategory(loc, 2)).toBe("many");
      expect(pluralCategory(loc, 5)).toBe("many");
    }
  });
});

describe("message catalog completeness", () => {
  // `en` is the source of truth for the key set (spec: messages.ts top comment).
  //
  // The catalogs fall into two families, decided by how many plural forms the
  // language needs. sk and cs need 1 / 2-4 / 5+, so they carry an extra `.few`
  // for every plural family; en, de and es need only 1 / other, so their key
  // sets are identical to en's. Every catalog is therefore a superset of en,
  // and each family agrees with itself exactly.
  const THREE_FORM: Locale[] = ["sk", "cs"];
  const TWO_FORM: Locale[] = LOCALES.filter((l) => !THREE_FORM.includes(l));
  const keysOf = (loc: Locale) => Object.keys(messages[loc]);
  const enKeys = keysOf("en");

  it("every en key exists in every other locale", () => {
    for (const loc of LOCALES) {
      const set = new Set(keysOf(loc));
      expect(
        enKeys.filter((k) => !set.has(k)),
        `${loc} is missing keys that en has`,
      ).toEqual([]);
    }
  });

  it("the two-form locales have exactly en's key set (no stray .few)", () => {
    // A `.few` key in de or es is unreachable: pluralCategory never returns
    // "few" for them, so the string would sit in the catalog looking translated
    // and never render. This is the test that catches it.
    for (const loc of TWO_FORM) {
      const keys = keysOf(loc);
      const enSet = new Set(enKeys);
      expect(keys.filter((k) => !enSet.has(k)), `${loc} has keys en does not`).toEqual([]);
      expect(keys.filter((k) => k.endsWith(".few")), `${loc} has unreachable .few keys`).toEqual(
        [],
      );
    }
  });

  it("the three-form locales have exactly the same key set as each other", () => {
    const [first, ...rest] = THREE_FORM;
    const firstKeys = keysOf(first);
    const firstSet = new Set(firstKeys);
    for (const loc of rest) {
      const set = new Set(keysOf(loc));
      expect(firstKeys.filter((k) => !set.has(k)), `${loc} missing vs ${first}`).toEqual([]);
      expect(keysOf(loc).filter((k) => !firstSet.has(k)), `${loc} extra vs ${first}`).toEqual([]);
    }
  });

  it("no duplicate keys within a locale", () => {
    for (const locale of LOCALES) {
      const seen = new Set<string>();
      const dupes = keysOf(locale).filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
      expect(dupes, `duplicate keys in ${locale}`).toEqual([]);
    }
  });

  it("every .one plural family has the forms its locale needs", () => {
    const oneKeys = enKeys.filter((k) => k.endsWith(".one"));
    expect(oneKeys.length).toBeGreaterThan(0);
    for (const loc of LOCALES) {
      const set = new Set(keysOf(loc));
      const needed = THREE_FORM.includes(loc)
        ? ([".few", ".many"] as const)
        : ([".many"] as const);
      for (const key of oneKeys) {
        const base = key.slice(0, -".one".length);
        for (const suffix of needed) {
          expect(set.has(base + suffix), `${loc} missing ${base}${suffix}`).toBe(true);
        }
      }
    }
  });
});

describe("event-language adoption (spec §7.1)", () => {
  it("adopts an available event language when the user has NO explicit choice", () => {
    i18n.locale = "en";
    i18n.explicit = false;
    i18n.adoptEventLang("sk");
    expect(i18n.locale).toBe("sk");
    i18n.locale = "en";
  });

  it("ignores the event language once the user has explicitly chosen", () => {
    i18n.explicit = true;
    i18n.locale = "en";
    i18n.adoptEventLang("sk");
    expect(i18n.locale).toBe("en");
    i18n.explicit = false;
  });

  it("ignores unavailable languages and falls back to the current locale", () => {
    // The unshipped language is PICKED from LOCALES rather than written down.
    // This test used to hardcode "de" with the note "no de catalog today", and
    // the day German shipped it started asserting that German was ignored.
    const unshipped = ["fr", "ja", "pt", "fi"].find((l) => !(LOCALES as string[]).includes(l));
    expect(unshipped, "every candidate is now a shipped locale").toBeTruthy();
    i18n.explicit = false;
    i18n.locale = "en";
    i18n.adoptEventLang(unshipped!);
    expect(i18n.locale).toBe("en");
  });

  it("set() marks the choice explicit so it wins thereafter", () => {
    i18n.explicit = false;
    i18n.set("en");
    expect(i18n.explicit).toBe(true);
    i18n.adoptEventLang("sk");
    expect(i18n.locale).toBe("en");
    i18n.explicit = false;
  });
});

describe("init() (a returning visitor reloading the app)", () => {
  // Neither global exists under this package's vitest "node" environment
  // (no jsdom) — minimal stubs, same pattern as other test files in this repo
  // (e.g. ndk.test.ts stubbing globalThis.indexedDB).
  const originalDocument = (globalThis as { document?: unknown }).document;
  const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const store = new Map<string, string>();

  beforeEach(() => {
    (globalThis as { document?: unknown }).document = { documentElement: { lang: "en" } };
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterEach(() => {
    store.clear();
    i18n.explicit = false;
    i18n.locale = "en";
    (globalThis as { document?: unknown }).document = originalDocument;
    (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
  });

  it("restores a persisted explicit choice AND updates <html lang> to match", () => {
    // Regression: init() correctly restored i18n.locale (so every visible
    // string was already localized), but never touched
    // document.documentElement.lang — only set()/adoptEventLang() did. A
    // returning Slovak-locale visitor kept <html lang="en"> forever after
    // their first reload, which is what screen readers and the browser's own
    // offer-to-translate prompt read, independent of the (correct) UI text.
    localStorage.setItem("nostrautica:lang", "sk");
    i18n.init();
    expect(i18n.locale).toBe("sk");
    expect(i18n.explicit).toBe(true);
    expect(document.documentElement.lang).toBe("sk");
  });

  it("also sets <html lang> on the browser-detected (non-explicit) path", () => {
    i18n.init(); // no stored choice — falls through to detect()
    expect(document.documentElement.lang).toBe(i18n.locale);
  });
});

describe("invite-link language (?lang=)", () => {
  const originalDocument = (globalThis as { document?: unknown }).document;
  const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const originalLocation = (globalThis as { location?: unknown }).location;
  const store = new Map<string, string>();

  function arriveAt(hash: string): void {
    (globalThis as { location?: unknown }).location = { hash };
  }

  beforeEach(() => {
    (globalThis as { document?: unknown }).document = { documentElement: { lang: "en" } };
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    arriveAt("");
  });
  afterEach(() => {
    store.clear();
    i18n.explicit = false;
    i18n.locale = "en";
    (globalThis as { document?: unknown }).document = originalDocument;
    (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
    (globalThis as { location?: unknown }).location = originalLocation;
  });

  it("parses the param out of a real invite link, and only for catalog locales", () => {
    const naddr = "naddr1abc";
    expect(langFromHash(`#/e/${naddr}/join?code=nsec1xyz&lang=sk`)).toBe("sk");
    // Region subtags are normalized away; the code is ISO 639-1.
    expect(langFromHash(`#/e/${naddr}/join?code=nsec1xyz&lang=cs-CZ`)).toBe("cs");
    // A language with no catalog (the 31600 `lang` tag is any ISO 639-1) must
    // fall through to detection rather than pick a wrong catalog.
    expect(langFromHash(`#/e/${naddr}/join?code=nsec1xyz&lang=hu`)).toBeUndefined();
    // Attacker-supplied: never anything but one of the shipped locales.
    expect(langFromHash("#/e/x/join?lang=../../etc/passwd")).toBeUndefined();
    expect(langFromHash(`#/e/${naddr}/join?code=nsec1xyz`)).toBeUndefined();
    expect(langFromHash("#/e/naddr1abc/join")).toBeUndefined();
  });

  it("switches a first-time visitor before any relay fetch, and remembers it", () => {
    // The whole point of putting the language on the LINK: this runs at boot,
    // with no event config in hand.
    arriveAt("#/e/naddr1abc/join?code=nsec1xyz&lang=sk");
    i18n.init();
    expect(i18n.locale).toBe("sk");
    expect(document.documentElement.lang).toBe("sk");
    // Not an explicit choice — a later Settings pick and the event-config path
    // both still work.
    expect(i18n.explicit).toBe(false);

    // Second visit, no param (the code was stripped from the URL after join):
    // the invitee stays in Slovak instead of falling back to navigator.language.
    i18n.locale = "en";
    arriveAt("#/e/naddr1abc");
    i18n.init();
    expect(i18n.locale).toBe("sk");
    expect(i18n.explicit).toBe(false);
  });

  it("never overrides a language the user picked in Settings", () => {
    // The requirement that makes this safe to ship: someone who has been here
    // before and chose Czech stays in Czech, even arriving on a Slovak event's
    // invite link.
    store.set("nostrautica:lang", "cs");
    arriveAt("#/e/naddr1abc/join?code=nsec1xyz&lang=sk");
    i18n.init();
    expect(i18n.locale).toBe("cs");
    expect(i18n.explicit).toBe(true);
    // ...and the soft default was not written behind their back.
    expect(store.get("nostrautica:lang:default")).toBeUndefined();
  });

  it("an explicit choice made later wins over a remembered invite language", () => {
    arriveAt("#/e/naddr1abc/join?code=nsec1xyz&lang=sk");
    i18n.init();
    expect(i18n.locale).toBe("sk");
    i18n.set("en"); // the invitee opens Settings and picks English
    i18n.locale = "sk"; // ...reload
    arriveAt("#/e/naddr1abc/join?code=nsec1abc&lang=sk");
    i18n.init();
    expect(i18n.locale).toBe("en");
    expect(i18n.explicit).toBe(true);
  });
});

describe("i18n plural resolution", () => {
  it("picks the count-appropriate form with {n}", () => {
    i18n.set("en");
    expect(i18n.tp("attendees.count", 1)).toBe("1 attendee");
    expect(i18n.tp("attendees.count", 3)).toBe("3 attendees");
    i18n.set("sk");
    expect(i18n.tp("attendees.count", 1)).toBe("1 účastník");
    expect(i18n.tp("attendees.count", 3)).toBe("3 účastníci");
    expect(i18n.tp("attendees.count", 5)).toBe("5 účastníkov");
    i18n.set("cs");
    expect(i18n.tp("attendees.count", 1)).toBe("1 účastník");
    expect(i18n.tp("attendees.count", 3)).toBe("3 účastníci");
    expect(i18n.tp("attendees.count", 5)).toBe("5 účastníků");
    i18n.set("en");
  });
});

describe("counter totals are never hard-coded in message text", () => {
  // Regression: "event.offline.downloading" read "Downloading… ({n} of 6)" in
  // every locale while the offline pack had grown to eight steps, so the card
  // rendered "Downloading… (8 of 6)". A total that lives in the string cannot be
  // kept in sync with the code that counts; it must be a parameter.
  it("the offline download counter takes its total as a parameter", () => {
    for (const locale of LOCALES) {
      const text = messages[locale]["event.offline.downloading"] as string;
      expect(text, locale).toContain("{n}");
      expect(text, locale).toContain("{total}");
      expect(text, locale).not.toMatch(/\d/);
    }
  });
});
