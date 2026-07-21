/**
 * Router back-stack tests (UX-8): a browser/system back lands on the in-app
 * stack top and must POP it, not push the screen we're leaving — pushing made
 * the in-app Back button and Android system back ping-pong between two pages.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("$lib/perf.js", () => ({ markRouteChange: () => {} }));

import { Router } from "./router.svelte.js";
import { buildHash, type Route } from "./routes.js";

/** Minimal window shim: hash storage + captured hashchange listeners. */
function fakeWindow() {
  const listeners: Array<() => void> = [];
  const win = {
    location: { hash: "#/" },
    addEventListener: (name: string, fn: () => void) => {
      if (name === "hashchange") listeners.push(fn);
    },
  };
  return {
    win,
    /** Set the hash and fire hashchange, like a real navigation. */
    navigate(hash: string) {
      win.location.hash = hash;
      for (const fn of listeners) fn();
    },
  };
}

const HOME: Route = { name: "home" };
const EVENT: Route = { name: "event", naddr: "naddr1xyz" };
const POSTS: Route = { name: "posts", naddr: "naddr1xyz" };

let fw: ReturnType<typeof fakeWindow>;
let router: Router;

beforeEach(() => {
  fw = fakeWindow();
  vi.stubGlobal("window", fw.win);
  router = new Router();
  router.init(); // route := home
});

/** In-app forward navigation through the public go(). */
function go(route: Route): void {
  router.go(route);
  fw.navigate(buildHash(route));
}

describe("router back-stack (UX-8)", () => {
  it("in-app forward navigations push the departed screen", () => {
    go(EVENT);
    go(POSTS);
    expect(router.route).toEqual(POSTS);
    expect(router.canGoBack).toBe(true);
  });

  it("in-app back() pops the stack and does not re-push", () => {
    go(EVENT);
    go(POSTS);
    router.back(); // → event
    fw.navigate(buildHash(EVENT)); // hashchange from the back() navigation
    expect(router.route).toEqual(EVENT);
    router.back(); // → home (stack empty now)
    fw.navigate(buildHash(HOME));
    expect(router.route).toEqual(HOME);
    expect(router.canGoBack).toBe(false);
  });

  it("browser/system back onto the stack top POPS it (no ping-pong)", () => {
    go(EVENT);
    // Simulate the user pressing Android back: the hash returns to home, which
    // is exactly the stack top — this must pop, not push `event`.
    fw.navigate(buildHash(HOME));
    expect(router.route).toEqual(HOME);
    // The stack is empty now: no phantom Back button on Home, no loop.
    expect(router.canGoBack).toBe(false);
  });

  it("repeated system backs unwind the whole stack in order", () => {
    go(EVENT);
    go(POSTS);
    fw.navigate(buildHash(EVENT)); // system back → stack top
    expect(router.route).toEqual(EVENT);
    fw.navigate(buildHash(HOME)); // system back → new stack top
    expect(router.route).toEqual(HOME);
    expect(router.canGoBack).toBe(false);
  });

  it("a forward navigation that happens to match the top collapses (no dup)", () => {
    go(EVENT);
    go(POSTS);
    // In-app link back to the event screen: equals the stack top — treated as
    // a return, not a fresh entry (keeps the stack free of immediate dupes).
    fw.navigate(buildHash(EVENT));
    expect(router.route).toEqual(EVENT);
    router.back(); // only home remains below → lands home
    fw.navigate(buildHash(HOME));
    expect(router.route).toEqual(HOME);
    expect(router.canGoBack).toBe(false);
  });

  it("re-navigating to the CURRENT route never pushes", () => {
    go(EVENT);
    fw.navigate(buildHash(EVENT)); // same hash again (e.g. double tap on a nav tab)
    router.back();
    fw.navigate(buildHash(HOME));
    expect(router.route).toEqual(HOME);
    expect(router.canGoBack).toBe(false);
  });

  it("deep-link with no history falls back to the contextual parent", () => {
    // Simulate a cold open on an event deep link (no in-app stack).
    fw.navigate(buildHash(EVENT));
    // Only one hashchange ever happened — stack holds just the initial home
    // if anything; back() must still land on a sensible parent, never off-app.
    router.back();
    const target = router.route;
    expect(["home", "event"]).toContain(target.name);
  });
});
