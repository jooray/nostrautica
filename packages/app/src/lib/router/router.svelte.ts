/**
 * Reactive hash-router store (spec §10.1). Wraps the pure `parseHash` in a rune
 * that tracks `location.hash`; `navigate` updates the hash (which triggers the
 * `hashchange` listener and re-derives the route).
 *
 * Also keeps an in-app navigation stack so a "Back" control can return to the
 * previous screen smartly — and, when there's no history (e.g. the user opened a
 * deep invite link), falls back to the route's contextual parent instead of
 * leaving the app.
 */
import { parseHash, buildHash, eventNaddr, type Route } from "./routes.js";
import type { MessageKey } from "$lib/i18n/messages.js";
import { markRouteChange } from "$lib/perf.js";

/**
 * The sensible parent screen for a route in the app's screen hierarchy.
 *
 * `origin` is the active event context (see Router.eventOrigin): when the user
 * walked from an event into the global chat list / a DM thread, the chat list's
 * parent is that event's home, not the global events list — so "up" unwinds
 * DM → chat list → event → All events, keeping them inside the event as long as
 * possible (Bug 1 UX). Without an origin (a fresh tab opened straight to a DM),
 * the chat list rises to Home as before, never fabricating an event context.
 */
function parentOf(route: Route, origin?: string): Route | null {
  switch (route.name) {
    // Every event subpage rises to the event home — a group chat, the matches
    // tab, the post-event report all go "up" to Overview, never off to Home.
    case "join":
    case "record":
    case "attendees":
    case "matches":
    case "report":
    case "chat":
    case "talks":
    case "admin":
    case "eventSettings":
    case "posts":
    case "eventMore":
      return { name: "event", naddr: route.naddr };
    case "attendee":
      return { name: "attendees", naddr: route.naddr };
    case "talk":
      return { name: "talks", naddr: route.naddr };
    case "post":
      return { name: "posts", naddr: route.naddr };
    case "myProfile":
      return { name: "eventMore", naddr: route.naddr };
    case "dmPeer":
      return { name: "dm" };
    case "dm":
      // Carry the event context back up when we entered chat from an event.
      return origin ? { name: "event", naddr: origin } : { name: "home" };
    case "event":
    case "create":
    case "me":
    case "settings":
    case "login":
      return { name: "home" };
    default:
      return null;
  }
}

/**
 * i18n key for the top-bar "up" button's label, named after where it goes
 * (Android Up-button convention). The one case the product pins explicitly:
 * the event home page's button reads "All events". Everything else is labelled
 * by its parent screen so the destination is predictable before you tap.
 */
export function upLabelKey(route: Route, origin?: string): MessageKey {
  const parent = parentOf(route, origin);
  if (!parent) return "nav.back";
  switch (parent.name) {
    case "home":
      // Leaving an event → "All events"; a plain top-level page → generic "Back".
      return eventNaddr(route) !== undefined ? "more.allEvents" : "nav.back";
    case "event":
      return "nav.overview";
    case "attendees":
      return "nav.people";
    case "posts":
      return "nav.updates";
    case "dm":
      return "nav.chat";
    default:
      return "nav.back";
  }
}

/** sessionStorage key holding the active event context naddr (per tab, Bug 1). */
const ORIGIN_KEY = "nostrautica:activeEvent";

export class Router {
  route = $state<Route>({ name: "home" });
  /**
   * The naddr of the event the user is currently "inside", carried onto the
   * global chat list / DM routes so the full event nav + back-stack keep saying
   * "you're in this event" (Bug 1). Persisted in sessionStorage so it survives a
   * reload but is naturally per-tab: a brand-new tab opened straight to a DM
   * starts with no context, so deep links never fabricate one. Chosen over
   * router/history state (wiped by hash-only navigation) and a `from=` query
   * param (which would ride into copied/shared DM links and manufacture context
   * on open — exactly what must not happen).
   */
  eventOrigin = $state<string | undefined>(undefined);
  private stack: Route[] = [];
  private goingBack = false;

  init(): void {
    if (typeof window === "undefined") return;
    try {
      this.eventOrigin = sessionStorage.getItem(ORIGIN_KEY) ?? undefined;
    } catch {
      /* sessionStorage may be unavailable (private mode) — context is best-effort */
    }
    this.sync();
    window.addEventListener("hashchange", () => this.sync());
  }

  /**
   * Set (or clear) the active event context. Idempotent. Called by the layout as
   * the route changes: set to the event naddr on any event route, cleared on the
   * global events list (home). Persisted per-tab.
   */
  setEventOrigin(naddr: string | undefined): void {
    if (this.eventOrigin === naddr) return;
    this.eventOrigin = naddr;
    try {
      if (naddr) sessionStorage.setItem(ORIGIN_KEY, naddr);
      else sessionStorage.removeItem(ORIGIN_KEY);
    } catch {
      /* best-effort persistence */
    }
  }

  private sync(): void {
    const next = parseHash(window.location.hash);
    const nextHash = buildHash(next);
    if (this.goingBack) {
      this.goingBack = false;
    } else if (buildHash(this.route) !== nextHash) {
      const top = this.stack[this.stack.length - 1];
      if (top !== undefined && buildHash(top) === nextHash) {
        // The hashchange landed exactly on our stack top: that's a browser/
        // system BACK (Android), not a forward navigation. Pop instead of
        // pushing the screen we're leaving — pushing here made the in-app
        // Back button and the system Back ping-pong between two pages (UX-8).
        this.stack.pop();
      } else {
        // Push the screen we're leaving (cap the depth, avoid immediate dupes).
        this.stack.push(this.route);
        if (this.stack.length > 50) this.stack.shift();
      }
    }
    // Perf baseline (§1.3): page cache-paint/network-settled deltas measure from
    // here. Cheap and UI-free.
    markRouteChange();
    this.route = next;
  }

  /** Navigate to a route (or a raw hash string). */
  go(target: Route | string): void {
    const hash = typeof target === "string" ? target : buildHash(target);
    if (typeof window !== "undefined") window.location.hash = hash;
  }

  /** True unless we're on Home with nothing to go back to. */
  get canGoBack(): boolean {
    return this.route.name !== "home" || this.stack.length > 0;
  }

  /**
   * Hierarchical "up": always go to this screen's contextual PARENT, ignoring
   * the chronological back-stack. This is the top-bar button's action, so it's
   * predictable regardless of how the user arrived (deep link, tab switch,
   * notification) — a subtab always rises to the event home, the event home to
   * "All events", a 1:1 chat to the conversation list. When the stack top is
   * already that parent (the common linear drill-down), pop it too so the
   * chronological history stays coherent for Android's hardware Back.
   */
  up(): void {
    const target = parentOf(this.route, this.eventOrigin) ?? { name: "home" as const };
    const top = this.stack[this.stack.length - 1];
    if (top !== undefined && buildHash(top) === buildHash(target)) this.stack.pop();
    this.goingBack = true;
    this.go(target);
  }

  /**
   * Chronological back — used by Android's hardware Back button (via hashchange)
   * and any caller that wants "the previous screen." Returns to the previous
   * in-app screen if there is one, else to the contextual parent (never off the
   * app). The visible top-bar button uses `up()` instead (see above).
   */
  back(): void {
    const prev = this.stack.pop();
    const target = prev ?? parentOf(this.route, this.eventOrigin) ?? { name: "home" as const };
    this.goingBack = true;
    this.go(target);
  }
}

export const router = new Router();
