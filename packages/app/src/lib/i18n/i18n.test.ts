import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { i18n, pluralCategory } from "./i18n.svelte.js";
import { messages } from "./messages.js";

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
});

describe("message catalog completeness", () => {
  // `en` is the source of truth for the key set (spec: messages.ts top comment).
  // Slavic locales (sk/cs) additionally define a `.few` form for every `.one`/
  // `.many` plural family, since they need the 1 / 2-4 / 5+ split; English only
  // ever needs one/many. So sk and cs should have IDENTICAL key sets to each
  // other, and both should be supersets of en's key set.
  const enKeys = Object.keys(messages.en);
  const skKeys = Object.keys(messages.sk);
  const csKeys = Object.keys(messages.cs);

  it("every en key exists in sk and cs", () => {
    const skSet = new Set(skKeys);
    const csSet = new Set(csKeys);
    const missingFromSk = enKeys.filter((k) => !skSet.has(k));
    const missingFromCs = enKeys.filter((k) => !csSet.has(k));
    expect(missingFromSk).toEqual([]);
    expect(missingFromCs).toEqual([]);
  });

  it("sk and cs have exactly the same key set (same plural families)", () => {
    const skSet = new Set(skKeys);
    const csSet = new Set(csKeys);
    const missingFromCs = skKeys.filter((k) => !csSet.has(k));
    const extraInCs = csKeys.filter((k) => !skSet.has(k));
    expect(missingFromCs).toEqual([]);
    expect(extraInCs).toEqual([]);
  });

  it("no duplicate keys within a locale", () => {
    for (const [locale, keys] of Object.entries({ en: enKeys, sk: skKeys, cs: csKeys })) {
      const seen = new Set<string>();
      const dupes = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
      expect(dupes, `duplicate keys in ${locale}`).toEqual([]);
    }
  });

  it("every .one plural family has matching .few and .many forms in sk and cs", () => {
    const oneKeys = enKeys.filter((k) => k.endsWith(".one"));
    expect(oneKeys.length).toBeGreaterThan(0);
    const skSet = new Set(skKeys);
    const csSet = new Set(csKeys);
    for (const key of oneKeys) {
      const base = key.slice(0, -".one".length);
      for (const suffix of [".few", ".many"] as const) {
        expect(skSet.has(base + suffix), `sk missing ${base}${suffix}`).toBe(true);
        expect(csSet.has(base + suffix), `cs missing ${base}${suffix}`).toBe(true);
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
    i18n.explicit = false;
    i18n.locale = "en";
    i18n.adoptEventLang("de"); // no de catalog today
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
  // all three locales while the offline pack had grown to eight steps, so the
  // card rendered "Downloading… (8 of 6)". A total that lives in the string
  // cannot be kept in sync with the code that counts; it must be a parameter.
  it("the offline download counter takes its total as a parameter", () => {
    for (const locale of ["en", "sk", "cs"] as const) {
      const text = messages[locale]["event.offline.downloading"] as string;
      expect(text, locale).toContain("{n}");
      expect(text, locale).toContain("{total}");
      expect(text, locale).not.toMatch(/\d/);
    }
  });
});
