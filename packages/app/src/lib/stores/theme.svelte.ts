/**
 * Theme store (spec §10.5). Default from `prefers-color-scheme`; user override
 * persisted to localStorage (later mirrored into 30078 settings). Applied by
 * setting `data-theme` on <html>, which the CSS custom properties key off.
 */
export type ThemePref = "light" | "dark" | "system";

const STORAGE_KEY = "nostrautica:theme";

function systemDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

class ThemeStore {
  pref = $state<ThemePref>("system");

  get effective(): "light" | "dark" {
    if (this.pref === "system") return systemDark() ? "dark" : "light";
    return this.pref;
  }

  init(): void {
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(STORAGE_KEY) as ThemePref | null;
      if (saved === "light" || saved === "dark" || saved === "system") {
        this.pref = saved;
      }
    }
    this.apply();
  }

  set(pref: ThemePref): void {
    this.pref = pref;
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, pref);
    this.apply();
  }

  private apply(): void {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", this.effective);
    }
  }
}

export const theme = new ThemeStore();
