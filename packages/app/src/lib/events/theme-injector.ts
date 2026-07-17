/**
 * Event theme injector (spec §7.4 kind 31609). Exactly ONE
 * `<style data-event-theme>` element exists, and only while a route under
 * `#/e/<naddr>` is active — it is removed on leaving the event and is never
 * present on login/settings/key-backup/DM routes (those routes carry no event
 * naddr; see `eventNaddr` in router/routes.ts). Switching events swaps the
 * element's content atomically, so a second event's CSS can never bleed in.
 */
import { loadEventContext, cachedEventContext } from "./event-context.js";
import { parseCoordinate } from "@nostrautica/protocol";
import { fetchEventTheme, cachedEventTheme } from "./theme.js";
import { avatarHues } from "$lib/identity/avatar.js";

const ATTR = "data-event-theme";
const WASH_ATTR = "data-event-wash";

let activeNaddr: string | undefined;
let requestToken = 0; // invalidates in-flight fetches on navigation

function styleEl(): HTMLStyleElement | null {
  return document.querySelector(`style[${ATTR}]`);
}

function washEl(): HTMLStyleElement | null {
  return document.querySelector(`style[${WASH_ATTR}]`);
}

function inject(naddr: string, css: string): void {
  let el = styleEl();
  if (!el) {
    el = document.createElement("style");
    document.head.appendChild(el);
  }
  el.setAttribute(ATTR, naddr);
  el.textContent = css;
  activeNaddr = naddr;
}

/**
 * The event colour wash (redesign §6.5). Sets `--event-h1/--event-h2` (from the
 * event pubkey) on :root so `--event-wash` in app.css resolves per event. The
 * wash <style> is ALWAYS inserted before any `data-event-theme` element, so an
 * organizer's 31609 CSS (a later stylesheet) can override the hues or the wash
 * outright — the layering contract from §1.2 holds by construction.
 *
 * The wash needs only the coordinate (no network), so it applies synchronously.
 */
export function syncEventWash(coordinate: string | undefined): void {
  if (typeof document === "undefined") return;
  let el = washEl();
  if (!coordinate) {
    el?.remove();
    return;
  }
  let h1 = 256,
    h2 = 322;
  try {
    const { pubkey } = parseCoordinate(coordinate);
    [h1, h2] = avatarHues(pubkey);
  } catch {
    /* keep the brand defaults */
  }
  if (!el) {
    el = document.createElement("style");
    el.setAttribute(WASH_ATTR, "");
    // Insert BEFORE the theme element so 31609 CSS always wins the cascade.
    document.head.insertBefore(el, styleEl() ?? null);
  }
  el.textContent = `:root { --event-h1: ${h1.toFixed(0)}; --event-h2: ${h2.toFixed(0)}; }`;
}

/** Remove the theme element (leaving the event / entering a bare route). */
export function clearEventTheme(): void {
  requestToken++;
  styleEl()?.remove();
  washEl()?.remove();
  activeNaddr = undefined;
}

/**
 * Live preview from the Admin appearance editor. Admin is itself an event
 * route, so previewing there respects the "event routes only" rule.
 */
export function previewEventTheme(naddr: string, css: string): void {
  inject(naddr, css);
}

/**
 * Reconcile the theme with the current route. Call with `eventNaddr(route)`
 * on every route change: undefined clears; a new naddr fetches that event's
 * 31609 and injects it (late responses from a superseded navigation are
 * dropped via the request token).
 */
export async function syncEventTheme(naddr: string | undefined): Promise<void> {
  if (typeof document === "undefined") return;
  if (!naddr) {
    clearEventTheme();
    return;
  }
  if (naddr === activeNaddr) return; // same event — keep the current style
  clearEventTheme();
  const token = requestToken;
  // Apply the wash as early as possible: synchronously from cache when we have it.
  const cached = cachedEventContext(naddr);
  if (cached) {
    syncEventWash(cached.coordinate);
    // Apply the cached 31609 CSS synchronously too (§2.12) — no unthemed flash on
    // reload/re-entry; the fetch below refreshes it in the background.
    const cachedCss = cachedEventTheme(cached.coordinate);
    if (cachedCss) inject(naddr, cachedCss);
  }
  try {
    const ctx = cached ?? (await loadEventContext(naddr));
    if (token !== requestToken) return; // navigated away meanwhile
    if (!cached) syncEventWash(ctx.coordinate);
    const css = await fetchEventTheme(ctx);
    if (token !== requestToken) return; // navigated away meanwhile
    if (css) inject(naddr, css);
    else activeNaddr = naddr; // remember "no theme" so we don't refetch per subroute
  } catch {
    if (token === requestToken) activeNaddr = naddr;
  }
}

/**
 * Force a refetch of the active event's theme (after publishing from Admin,
 * or to discard an unsaved live preview).
 */
export async function resyncEventTheme(naddr: string): Promise<void> {
  clearEventTheme();
  await syncEventTheme(naddr);
}
