import { describe, it, expect } from "vitest";
import { i18n, pluralCategory } from "./i18n.svelte.js";

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

describe("i18n plural resolution", () => {
  it("picks the count-appropriate form with {n}", () => {
    i18n.set("en");
    expect(i18n.tp("attendees.count", 1)).toBe("1 attendee");
    expect(i18n.tp("attendees.count", 3)).toBe("3 attendees");
    i18n.set("sk");
    expect(i18n.tp("attendees.count", 1)).toBe("1 účastník");
    expect(i18n.tp("attendees.count", 3)).toBe("3 účastníci");
    expect(i18n.tp("attendees.count", 5)).toBe("5 účastníkov");
    i18n.set("en");
  });
});
