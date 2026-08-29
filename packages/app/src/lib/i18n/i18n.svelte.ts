/**
 * Reactive locale store (spec §10.5). Default from the browser language; user
 * override persisted to localStorage (mirrored into 30078 settings elsewhere).
 * `t(key)` falls back to English, then to the key itself.
 *
 * Interpolation: `t("key", { name })` substitutes `{name}` placeholders — keep
 * whole phrases in the catalog so translations control word order (concatenating
 * translated fragments breaks Slovak).
 *
 * Pluralization: `tp("key", n, params)` picks a plural form by suffixing the key
 * with the locale's category (`.one` / `.few` / `.many`) and exposes the count as
 * `{n}`. Slovak and Czech have three forms (1 / 2–4 / 5+); English collapses to
 * one / many.
 */
import { messages, LOCALES, type Locale, type MessageKey } from "./messages.js";

/** An EXPLICIT choice made on the Settings page. Outranks everything. */
const STORAGE_KEY = "nostrautica:lang";
/**
 * A SOFT default adopted from an invite link's `lang=` — the organizer of the
 * event this person was invited to stating what language that event is held in.
 * Outranks browser detection, loses to an explicit Settings choice. Kept in a
 * SEPARATE key precisely so it can never be mistaken for one: `explicit` gates
 * every event-driven switch, and writing the event's language into STORAGE_KEY
 * would silently freeze the UI for someone who never chose anything.
 */
const DEFAULT_KEY = "nostrautica:lang:default";

function detect(): Locale {
  if (typeof navigator === "undefined") return "en";
  const lang = navigator.language.slice(0, 2).toLowerCase();
  return (LOCALES as string[]).includes(lang) ? (lang as Locale) : "en";
}

/** A stored/param locale value, or undefined when absent or not a catalog locale. */
function asLocale(value: string | null | undefined): Locale | undefined {
  if (!value) return undefined;
  const base = value.trim().slice(0, 2).toLowerCase();
  return (LOCALES as string[]).includes(base) ? (base as Locale) : undefined;
}

/**
 * The `lang=` query parameter carried by an invite link
 * (`#/e/<naddr>/join?code=<nsec>&lang=sk`, built in events/organizer.ts).
 *
 * Why the link and not just the event config: `adoptEventLang` can only run once
 * the 31600 has come back from relays, so the whole cold boot an invite link
 * produces — splash, join skeleton, every error state on the way — paints in the
 * browser's language and then flips. The link is the one piece of the event that
 * is in hand before any network round-trip.
 *
 * The value is attacker-supplied (anyone can craft a link), which is survivable
 * because the only thing it can do is pick one of the three shipped catalogs and
 * it can never set `explicit` — a wrong guess is one Settings visit away from
 * being fixed, and can never overwrite a choice the user already made.
 *
 * Pure (takes the hash rather than reading `location`) so the precedence rules
 * are unit-testable.
 */
export function langFromHash(hash: string): Locale | undefined {
  const q = hash.indexOf("?");
  if (q < 0) return undefined;
  return asLocale(new URLSearchParams(hash.slice(q + 1)).get("lang"));
}

export type PluralCategory = "one" | "few" | "many";

/** Plural category for a count, per locale (en: 1 / other; sk/cs: 1 / 2–4 / 5+). */
export function pluralCategory(locale: Locale, n: number): PluralCategory {
  const abs = Math.abs(n);
  if (locale === "sk" || locale === "cs") {
    if (abs === 1) return "one";
    if (abs >= 2 && abs <= 4) return "few";
    return "many";
  }
  return abs === 1 ? "one" : "many";
}

/** Fill `{placeholder}` tokens in a template from `params`. */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    k in params ? String(params[k]) : `{${k}}`,
  );
}

class I18n {
  locale = $state<Locale>("en");
  /** True once the user has EXPLICITLY picked a language on the Settings page. An
   *  explicit choice is persisted (STORAGE_KEY present) and always wins over any
   *  event-driven default. */
  explicit = $state(false);

  /**
   * Set the locale AND `<html lang>` together. They are one fact, and every path
   * that moved only the first half has been a bug: a returning visitor with an
   * explicit non-English choice (or a first-time one whose browser detect()s to
   * sk/cs) used to keep app.html's default `lang="en"` after every reload, so
   * screen readers and the browser's own offer-to-translate prompt read the
   * wrong language while every visible string was correctly localized.
   */
  private apply(locale: Locale): void {
    this.locale = locale;
    if (typeof document !== "undefined") document.documentElement.lang = locale;
  }

  /**
   * Resolve the startup locale. Three tiers, strongest first:
   *
   *   1. STORAGE_KEY  — an explicit Settings pick. Nothing overrides it, and it
   *      is the reason `explicit` exists: it also disables every later
   *      event-driven switch for the rest of the session.
   *   2. `lang=` on an invite link, else DEFAULT_KEY — "the event you were
   *      invited to is held in this language." Applied before the first paint
   *      and PERSISTED, so the invitee's second visit doesn't fall back to
   *      whatever their browser claims. Never sets `explicit`.
   *   3. navigator.language, else English.
   *
   * The invite param is persisted but merely *browsing* an event is not
   * (see adoptEventLang): being handed a code for a Slovak event is a statement
   * about the person, opening someone's event page is a statement about the page.
   */
  init(): void {
    const store = typeof localStorage !== "undefined" ? localStorage : undefined;

    const explicit = asLocale(store?.getItem(STORAGE_KEY));
    if (explicit) {
      this.explicit = true;
      this.apply(explicit);
      return;
    }

    const invited = typeof location !== "undefined" ? langFromHash(location.hash) : undefined;
    if (invited) {
      store?.setItem(DEFAULT_KEY, invited);
      this.apply(invited);
      return;
    }

    const remembered = asLocale(store?.getItem(DEFAULT_KEY));
    this.apply(remembered ?? detect());
  }

  set(locale: Locale): void {
    this.explicit = true;
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, locale);
    this.apply(locale);
  }

  /**
   * Adopt an event's language for the session (spec §7.1). Called on event-scoped
   * pages: if the user hasn't made an explicit choice and the event's language maps
   * to an available catalog locale, switch to it WITHOUT writing the explicit-choice
   * key — so leaving the event (or a later explicit Settings choice) still works.
   * No-op when the user has an explicit choice or the language isn't available.
   *
   * Deliberately NOT persisted, unlike the invite link's `lang=` (see init):
   * merely opening someone's Slovak event should not retune this browser's
   * default for every event after it. The invite flow doesn't need it to —
   * the link carries the language itself.
   */
  adoptEventLang(lang: string | undefined): void {
    if (this.explicit) return;
    const base = asLocale(lang);
    if (!base) return;
    this.apply(base);
  }

  raw(key: MessageKey): string {
    return messages[this.locale][key] ?? messages.en[key] ?? key;
  }

  t(key: MessageKey, params?: Record<string, string | number>): string {
    return interpolate(this.raw(key), params);
  }

  tp(base: string, n: number, params?: Record<string, string | number>): string {
    const cat = pluralCategory(this.locale, n);
    // Fall back through categories so a locale needn't define every form.
    const candidates = [`${base}.${cat}`, `${base}.many`, `${base}.one`] as MessageKey[];
    const raw =
      candidates.map((k) => messages[this.locale][k] ?? messages.en[k]).find(Boolean) ?? base;
    return interpolate(raw, { n, ...params });
  }
}

export const i18n = new I18n();

/** Convenience translator bound to the reactive locale. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  return i18n.t(key, params);
}

/** Plural-aware translator: `tp("attendees.count", n)`. */
export function tp(base: string, n: number, params?: Record<string, string | number>): string {
  return i18n.tp(base, n, params);
}
