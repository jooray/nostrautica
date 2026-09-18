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
function parentOf(route: Route, origin?: string, dmReturn?: string): Route | null {
  switch (route.name) {
    // Every event subpage rises to the event home — a group chat, the People
    // list, the post-event report all go "up" to Overview, never off to Home.
    case "join":
    case "record":
    case "attendees":
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
      /**
       * Back to wherever you opened this conversation from.
       *
       * The parent was always the conversations list, which is right when you
       * picked the thread out of that list and wrong the rest of the time. The
       * common path through this app is not "open messages, choose a person" —
       * it is browsing People, finding someone worth talking to, writing to
       * them, and wanting to carry on down the list. Up sent those users to a
       * list of conversations they never asked for, and the roster they were
       * working through was two more taps away.
       *
       * So the DM remembers the screen it was entered from (Router.dmReturn),
       * and falls back to the conversations list when it was entered from
       * there, or when nothing is remembered — a cold deep link into a thread,
       * or a tab whose sessionStorage is gone.
       */
      return dmReturn ? parseHash(dmReturn) : { name: "dm" };
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
export function upLabelKey(route: Route, origin?: string, dmReturn?: string): MessageKey {
  const parent = parentOf(route, origin, dmReturn);
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
/** sessionStorage key holding the hash a DM thread was opened from (per tab). */
const DM_RETURN_KEY = "nostrautica:dmReturn";

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
  /**
   * The hash of the screen the current DM thread was opened from, or undefined.
   * A hash rather than a Route so it round-trips through sessionStorage without
   * a bespoke serializer, and per-tab for the same reason `eventOrigin` is: a
   * fresh tab opened straight onto a thread must not inherit another tab's idea
   * of where "back" goes.
   */
  dmReturn = $state<string | undefined>(undefined);
  private stack: Route[] = [];
  private goingBack = false;
  /**
   * False until the first `sync()` has run. A cold deep link straight into a DM
   * thread arrives while `route` is still the constructor's placeholder Home,
   * and without this the router would record Home as "where this conversation
   * was opened from" and send Up there instead of to the conversations list.
   * Nothing in the app can open a DM from Home, so that origin is always the
   * artifact and never a real one.
   */
  private booted = false;

  init(): void {
    if (typeof window === "undefined") return;
    try {
      this.eventOrigin = sessionStorage.getItem(ORIGIN_KEY) ?? undefined;
      this.dmReturn = sessionStorage.getItem(DM_RETURN_KEY) ?? undefined;
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
        // Push the screen we're leaving — capped in depth, and skipping an
        // IMMEDIATE DUPE. This comment claimed the dedupe for a long time before
        // the code did it; it does it now. Two consecutive entries naming the
        // same screen are what makes a later `back()` pop a target identical to
        // the screen the user is already on, which navigates nowhere. The
        // reachable route to that state was the latched `goingBack` flag (see
        // navigateBack), so this is now belt-and-braces rather than the primary
        // guard — but a stack that can't hold `[A, A]` can't produce a dead Back
        // button no matter how the flag behaves.
        const departing = this.route;
        if (top === undefined || buildHash(top) !== buildHash(departing)) {
          this.stack.push(departing);
          if (this.stack.length > 50) this.stack.shift();
        }
      }
    }
    this.noteDmReturn(next);
    // Perf baseline (§1.3): page cache-paint/network-settled deltas measure from
    // here. Cheap and UI-free.
    markRouteChange();
    this.route = next;
  }

  /** Navigate to a route (or a raw hash string). */
  /**
   * Record (or forget) where a DM thread was entered from, on every transition.
   *
   * Deliberately here rather than at the call sites that open a DM: they are
   * spread across the People list, a person's page, the conversations list and
   * a match's actions, and one of them forgetting to pass a return route would
   * be an inconsistency nobody would notice until they were lost in the app.
   * The router already knows which screen is being left.
   */
  private noteDmReturn(next: Route): void {
    if (!this.booted) {
      this.booted = true;
      return;
    }
    if (next.name === "dmPeer") {
      // Entering a thread from anywhere that is not itself chat: remember it.
      // Thread-to-thread moves keep the original return, which is what makes
      // replying to two people in a row still end up back at the roster.
      // Home is excluded for the same reason the boot guard exists: nothing in
      // the app can open a conversation from the events list, so a DM that
      // appears to have been entered from Home was entered by a deep link and
      // the conversations list is the honest place to send Up.
      const from = this.route.name;
      if (from !== "dmPeer" && from !== "dm" && from !== "home") {
        this.setDmReturn(buildHash(this.route));
      }
      return;
    }
    // Left the thread: the memory has done its job and a stale one would send a
    // later, unrelated DM somewhere surprising.
    if (this.dmReturn !== undefined) this.setDmReturn(undefined);
  }

  private setDmReturn(hash: string | undefined): void {
    this.dmReturn = hash;
    try {
      if (hash) sessionStorage.setItem(DM_RETURN_KEY, hash);
      else sessionStorage.removeItem(DM_RETURN_KEY);
    } catch {
      /* sessionStorage may be unavailable (private mode) — best-effort */
    }
  }

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
    const target = parentOf(this.route, this.eventOrigin, this.dmReturn) ?? { name: "home" as const };
    const top = this.stack[this.stack.length - 1];
    if (top !== undefined && buildHash(top) === buildHash(target)) this.stack.pop();
    this.navigateBack(target);
  }

  /**
   * Navigate "backwards" — the one place `goingBack` is latched, so it can never
   * be latched for a navigation that won't happen.
   *
   * Assigning `location.hash` the value it already holds fires NO `hashchange`,
   * so `sync()` never runs and never consumes the flag. It then stays true for
   * the rest of the session and the next genuine FORWARD navigation is
   * mis-classified as a back: the screen being left is not pushed, so in-app
   * Back skips a level from then on. The trivially reachable case is the top-bar
   * up button on Home — `parentOf(home)` is null, so the target is Home, which
   * is where we already are.
   */
  private navigateBack(target: Route): void {
    if (buildHash(target) === buildHash(this.route)) {
      // Already on the target: nothing to navigate to, and nothing to latch.
      this.goingBack = false;
      return;
    }
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
    // Skip stack entries that name the screen we're already on. A stale duplicate
    // (or a hash we arrived at by another route) would otherwise make Back a
    // no-op that LOOKS broken — the user taps, nothing moves, and the entry is
    // spent. Unwinding to the first genuinely different screen is what the user
    // meant by "back".
    const currentHash = buildHash(this.route);
    let prev: Route | undefined;
    while (this.stack.length > 0) {
      const candidate = this.stack.pop() as Route;
      if (buildHash(candidate) !== currentHash) {
        prev = candidate;
        break;
      }
    }
    const target = prev ?? parentOf(this.route, this.eventOrigin) ?? { name: "home" as const };
    this.navigateBack(target);
  }
}

export const router = new Router();
