/**
 * Is the window wide enough for the desktop shell (the left rail and the
 * two-pane People layout)?
 *
 * A rune rather than a CSS media query because the difference is structural,
 * not cosmetic: below this width the People list must NOT be mounted while a
 * person's page is open. Hiding it with `display:none` would still mount the
 * component, open its directory stream, and pay for a roster read on a phone
 * that is never going to show it.
 *
 * The breakpoint is the same 1000px the rail uses in app.css. It is repeated
 * here because CSS custom properties cannot be read by `matchMedia`; if one
 * moves, move both.
 */
const WIDE_QUERY = "(min-width: 1000px)";

class Viewport {
  /** True when the desktop shell applies. False during SSR and on phones. */
  wide = $state(false);
  private mql: MediaQueryList | undefined;

  init(): () => void {
    if (typeof window === "undefined" || !window.matchMedia) return () => {};
    this.mql = window.matchMedia(WIDE_QUERY);
    this.wide = this.mql.matches;
    const onChange = (e: MediaQueryListEvent) => (this.wide = e.matches);
    this.mql.addEventListener("change", onChange);
    return () => this.mql?.removeEventListener("change", onChange);
  }
}

export const viewport = new Viewport();
