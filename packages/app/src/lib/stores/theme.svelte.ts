/**
 * Theme store (spec §10.5). Default from `prefers-color-scheme`; user override
 * persisted to localStorage (later mirrored into 30078 settings). Applied by
 * setting `data-theme` on <html>, which the CSS custom properties key off.
 */
export type ThemePref = "light" | "dark" | "system";

const STORAGE_KEY = "nostrautica:theme";

// The effective page background per theme (mirrors --bg in app.css), used for
// the address-bar/theme-color <meta> so browser chrome matches the app surface.
const BG_COLOR = { dark: "#0e0e15", light: "#fafafc" } as const;

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
    // When following the system and it flips, re-apply so data-theme and the
    // theme-color meta track the OS without a reload.
    if (typeof window !== "undefined" && window.matchMedia) {
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .addEventListener?.("change", () => {
          if (this.pref === "system") this.apply();
        });
    }
  }

  set(pref: ThemePref): void {
    this.pref = pref;
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, pref);
    this.apply();
  }

  private apply(): void {
    if (typeof document === "undefined") return;
    const eff = this.effective;
    document.documentElement.setAttribute("data-theme", eff);
    // Keep the browser chrome (address bar) in step with the app surface.
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = BG_COLOR[eff];
  }
}

export const theme = new ThemeStore();
