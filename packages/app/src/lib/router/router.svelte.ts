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
import { parseHash, buildHash, type Route } from "./routes.js";
import { markRouteChange } from "$lib/perf.js";

/** The sensible parent screen for a route when there's no back-history. */
function parentOf(route: Route): Route | null {
  switch (route.name) {
    case "join":
    case "record":
    case "attendees":
    case "matches":
    case "admin":
    case "posts":
    case "eventMore":
      return { name: "event", naddr: route.naddr };
    case "attendee":
      return { name: "attendees", naddr: route.naddr };
    case "post":
      return { name: "posts", naddr: route.naddr };
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

class Router {
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
    if (this.goingBack) {
      this.goingBack = false;
    } else if (buildHash(this.route) !== buildHash(next)) {
      // Push the screen we're leaving (cap the depth, avoid immediate dupes).
      this.stack.push(this.route);
      if (this.stack.length > 50) this.stack.shift();
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
   * Smart back: return to the previous in-app screen if there is one; otherwise
   * to this screen's contextual parent (never off the app).
   */
  back(): void {
    const prev = this.stack.pop();
    const target = prev ?? parentOf(this.route) ?? { name: "home" as const };
    this.goingBack = true;
    this.go(target);
  }
}

export const router = new Router();
