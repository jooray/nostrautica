/**
 * Reactive locale store (spec §10.5). Default from the browser language; user
 * override persisted to localStorage (mirrored into 30078 settings elsewhere).
 * `t(key)` falls back to English, then to the key itself.
 */
import { messages, LOCALES, type Locale, type MessageKey } from "./messages.js";

const STORAGE_KEY = "nostrautica:lang";

function detect(): Locale {
  if (typeof navigator === "undefined") return "en";
  const lang = navigator.language.slice(0, 2).toLowerCase();
  return (LOCALES as string[]).includes(lang) ? (lang as Locale) : "en";
}

class I18n {
  locale = $state<Locale>("en");

  init(): void {
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && (LOCALES as string[]).includes(saved)) {
        this.locale = saved as Locale;
        return;
      }
    }
    this.locale = detect();
  }

  set(locale: Locale): void {
    this.locale = locale;
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, locale);
    if (typeof document !== "undefined") document.documentElement.lang = locale;
  }

  t(key: MessageKey): string {
    return messages[this.locale][key] ?? messages.en[key] ?? key;
  }
}

export const i18n = new I18n();

/** Convenience translator bound to the reactive locale. */
export function t(key: MessageKey): string {
  return i18n.t(key);
}
