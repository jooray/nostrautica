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

/** The sensible parent screen for a route in the app's screen hierarchy. */
function parentOf(route: Route): Route | null {
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
    case "event":
    case "create":
    case "me":
    case "settings":
    case "login":
    case "dm":
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
export function upLabelKey(route: Route): MessageKey {
  const parent = parentOf(route);
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

export class Router {
  route = $state<Route>({ name: "home" });
  private stack: Route[] = [];
  private goingBack = false;

  init(): void {
    if (typeof window === "undefined") return;
    this.sync();
    window.addEventListener("hashchange", () => this.sync());
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
    const target = parentOf(this.route) ?? { name: "home" as const };
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
    const target = prev ?? parentOf(this.route) ?? { name: "home" as const };
    this.goingBack = true;
    this.go(target);
  }
}

export const router = new Router();
