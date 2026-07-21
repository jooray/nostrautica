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

const STORAGE_KEY = "nostrautica:lang";

function detect(): Locale {
  if (typeof navigator === "undefined") return "en";
  const lang = navigator.language.slice(0, 2).toLowerCase();
  return (LOCALES as string[]).includes(lang) ? (lang as Locale) : "en";
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

  init(): void {
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && (LOCALES as string[]).includes(saved)) {
        this.locale = saved as Locale;
        this.explicit = true;
        if (typeof document !== "undefined") document.documentElement.lang = this.locale;
        return;
      }
    }
    this.locale = detect();
    // detect() can already return sk/cs from navigator.language — set() and
    // adoptEventLang() both keep <html lang> in step with the reactive locale,
    // but init()'s own assignment above didn't, so a returning visitor with an
    // explicit non-English choice (or a first-time one whose browser language
    // detect()s to sk/cs) kept the default <html lang="en"> from app.html
    // after every reload — screen readers and the browser's own
    // offer-to-translate prompt read the wrong language even though every
    // visible string was correctly localized.
    if (typeof document !== "undefined") document.documentElement.lang = this.locale;
  }

  set(locale: Locale): void {
    this.locale = locale;
    this.explicit = true;
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, locale);
    if (typeof document !== "undefined") document.documentElement.lang = locale;
  }

  /**
   * Adopt an event's language for the session (spec §7.1). Called on event-scoped
   * pages: if the user hasn't made an explicit choice and the event's language maps
   * to an available catalog locale, switch to it WITHOUT writing the explicit-choice
   * key — so leaving the event (or a later explicit Settings choice) still works.
   * No-op when the user has an explicit choice or the language isn't available.
   */
  adoptEventLang(lang: string | undefined): void {
    if (this.explicit || !lang) return;
    const base = lang.slice(0, 2).toLowerCase();
    if (!(LOCALES as string[]).includes(base)) return;
    this.locale = base as Locale;
    if (typeof document !== "undefined") document.documentElement.lang = base;
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
