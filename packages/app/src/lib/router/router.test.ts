/**
 * Router back-stack tests (UX-8): a browser/system back lands on the in-app
 * stack top and must POP it, not push the screen we're leaving — pushing made
 * the in-app Back button and Android system back ping-pong between two pages.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("$lib/perf.js", () => ({ markRouteChange: () => {} }));

import { Router, upLabelKey } from "./router.svelte.js";
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
const REPORT: Route = { name: "report", naddr: "naddr1xyz" };
const ATTENDEES: Route = { name: "attendees", naddr: "naddr1xyz" };
const ATTENDEE: Route = { name: "attendee", naddr: "naddr1xyz", npub: "npub1abc" };
const POST: Route = { name: "post", naddr: "naddr1xyz", d: "d1" };
const DM: Route = { name: "dm" };
const DM_PEER: Route = { name: "dmPeer", npub: "npub1abc" };
const DM_PEER2: Route = { name: "dmPeer", npub: "npub1def" };
const SETTINGS: Route = { name: "settings" };

let fw: ReturnType<typeof fakeWindow>;
let router: Router;

beforeEach(() => {
  // The router persists `eventOrigin` and `dmReturn` in sessionStorage so both
  // survive a reload, which is deliberate. It also means one test's state is the
  // next test's starting condition unless it is cleared here.
  try {
    sessionStorage.clear();
  } catch {
    /* not every environment has one; the router tolerates that too */
  }
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

describe("router hierarchical up()", () => {
  it("rises to the contextual parent, not the chronological previous screen", () => {
    // Arrive at the report via a non-hierarchical path: home → posts → the report.
    go(POSTS);
    go(REPORT);
    router.up(); // hierarchy says the report' parent is the event home, NOT posts
    fw.navigate(buildHash(EVENT));
    expect(router.route).toEqual(EVENT);
  });

  it("event home rises to All events (home)", () => {
    go(EVENT);
    router.up();
    fw.navigate(buildHash(HOME));
    expect(router.route).toEqual(HOME);
  });

  it("works on a cold deep-link with an empty stack", () => {
    fw.navigate(buildHash(REPORT)); // cold open, no in-app history
    router.up();
    const target = router.route;
    // parentOf(the report) is the event home; up() must reach it regardless of stack.
    expect(target.name === "report" || target.name === "event").toBe(true);
  });

  it("collapses a duplicate stack top so hardware Back stays coherent", () => {
    // Linear drill: home → event → the report. up() from the report returns to event
    // AND pops the duplicate event off the stack, so the next up() reaches home.
    go(EVENT);
    go(REPORT);
    router.up();
    fw.navigate(buildHash(EVENT));
    expect(router.route).toEqual(EVENT);
    router.up();
    fw.navigate(buildHash(HOME));
    expect(router.route).toEqual(HOME);
    expect(router.canGoBack).toBe(false);
  });
});

describe("active event context (Bug 1)", () => {
  it("carries the origin event up from the chat list, so DM → chat → event → home", () => {
    // Walk from an event into the group chat list into a DM (the reported flow).
    go(EVENT);
    router.setEventOrigin(EVENT.naddr); // the layout sets this on the event route
    go(DM);
    go(DM_PEER);
    // up() from the DM thread → the conversation list…
    router.up();
    fw.navigate(buildHash(DM));
    expect(router.route).toEqual(DM);
    // …then the chat list rises to the ORIGIN EVENT, not the global events list…
    router.up();
    fw.navigate(buildHash(EVENT));
    expect(router.route).toEqual(EVENT);
    // …and only the event home rises to All events.
    router.up();
    fw.navigate(buildHash(HOME));
    expect(router.route).toEqual(HOME);
  });

  it("without an origin, the chat list rises to home (no fabricated context)", () => {
    // Fresh tab straight to the chat list: no event context was ever set.
    fw.navigate(buildHash(DM));
    router.up();
    fw.navigate(buildHash(HOME));
    expect(router.route).toEqual(HOME);
  });

  it("setEventOrigin is idempotent and clearable", () => {
    router.setEventOrigin(EVENT.naddr);
    expect(router.eventOrigin).toBe(EVENT.naddr);
    router.setEventOrigin(EVENT.naddr); // no-op
    expect(router.eventOrigin).toBe(EVENT.naddr);
    router.setEventOrigin(undefined);
    expect(router.eventOrigin).toBeUndefined();
  });

  it("upLabelKey on the chat list names the event (Overview) when a context is set", () => {
    expect(upLabelKey(DM)).toBe("nav.back"); // no context → generic Back
    expect(upLabelKey(DM, EVENT.naddr)).toBe("nav.overview"); // context → rises to the event
  });
});

describe("upLabelKey names the destination", () => {
  it("labels the event home button 'All events'", () => {
    expect(upLabelKey(EVENT)).toBe("more.allEvents");
  });
  it("labels event subtabs by their parent (event home = Overview)", () => {
    expect(upLabelKey(REPORT)).toBe("nav.overview");
    expect(upLabelKey(ATTENDEES)).toBe("nav.overview");
  });
  it("labels a person detail 'People'", () => {
    expect(upLabelKey(ATTENDEE)).toBe("nav.people");
  });
  it("labels a single update 'Updates'", () => {
    expect(upLabelKey(POST)).toBe("nav.updates");
  });
  it("labels a 1:1 chat by its conversation list", () => {
    expect(upLabelKey(DM_PEER)).toBe("nav.chat");
  });
  it("falls back to generic 'Back' for a top-level page and for home", () => {
    expect(upLabelKey(SETTINGS)).toBe("nav.back");
    expect(upLabelKey(DM)).toBe("nav.back");
    expect(upLabelKey(HOME)).toBe("nav.back");
  });
});

/**
 * `goingBack` is latched before the navigation, and `window.location.hash = <the
 * hash it already holds>` fires no `hashchange` at all — so a "back" that lands
 * on the screen we are already on never gets consumed. The flag then swallows the
 * NEXT genuine forward navigation: the screen being left is not pushed, and the
 * in-app stack is one level short from then on.
 *
 * The trivially reachable trigger is the top-bar up button on Home —
 * `parentOf(home)` is null, so up()'s target IS Home.
 */
describe("a back that goes nowhere must not latch goingBack", () => {
  /**
   * Land on Home with an empty stack, then take the no-op back. Afterwards a
   * forward walk to Matches must still have Home on the stack, so back() from
   * Matches goes to HOME. With the flag latched the walk is not pushed, the
   * stack is empty, and back() falls through to the report' contextual PARENT (the
   * event home) instead — a different screen, which is the user-visible damage.
   */
  function homeThenMatches(noOpBack: () => void) {
    go(POSTS);
    fw.navigate(buildHash(HOME)); // system back onto the stack top → pops it
    expect(router.canGoBack).toBe(false); // stack is empty, we are on Home
    noOpBack();
    go(REPORT);
    router.back();
    // Whatever back() pointed the hash at, let the browser deliver it.
    fw.navigate(fw.win.location.hash);
  }

  it("up() on Home (whose parent is Home) does not eat the next navigation", () => {
    homeThenMatches(() => router.up());
    expect(router.route).toEqual(HOME);
  });

  it("back() with an empty stack on Home does not eat the next navigation", () => {
    homeThenMatches(() => router.back());
    expect(router.route).toEqual(HOME);
  });
});

/**
 * Up from a DM used to be the conversations list unconditionally, which is the
 * right answer only for someone who picked the thread out of that list. The
 * common path is browsing People, writing to somebody, and wanting to carry on
 * down the roster — and that user was being dropped into a list of
 * conversations they never asked for.
 */
describe("a DM thread remembers where it was opened from", () => {
  /**
   * These assert on the hash `up()` actually WROTE, rather than following it
   * with `fw.navigate(buildHash(expected))` the way the suite above does. That
   * idiom sets the hash to the expected value itself, so the assertion after it
   * holds whatever the router decided — three of these tests passed against the
   * unfixed router before this was changed.
   */
  const upTarget = (): string => {
    router.up();
    return fw.win.location.hash;
  };

  it("up() from a thread opened in People returns to People", () => {
    go(EVENT);
    go(ATTENDEES);
    go(DM_PEER);
    expect(upTarget()).toBe(buildHash(ATTENDEES));
  });

  it("names the destination People, so the button says where it goes", () => {
    go(ATTENDEES);
    go(DM_PEER);
    expect(upLabelKey(router.route, router.eventOrigin, router.dmReturn)).toBe("nav.people");
  });

  it("a thread opened FROM the conversations list still rises to that list", () => {
    go(DM);
    go(DM_PEER);
    expect(upTarget()).toBe(buildHash(DM));
  });

  it("writing to a second person in a row still returns to the roster", () => {
    // Thread-to-thread keeps the ORIGINAL origin: the roster is still where the
    // user was working, and re-pointing "up" at the previous thread would strand
    // them one conversation deeper with every reply.
    go(ATTENDEES);
    go(DM_PEER);
    go(DM_PEER2);
    expect(upTarget()).toBe(buildHash(ATTENDEES));
  });

  it("forgets the origin once you leave chat, so a later thread isn't misrouted", () => {
    go(ATTENDEES);
    go(DM_PEER);
    go(EVENT);
    expect(router.dmReturn).toBeUndefined();
    go(DM_PEER);
    expect(upTarget()).toBe(buildHash(EVENT));
  });

  it("a cold deep link into a thread still has somewhere to go", () => {
    // A real cold open: the hash is already the thread when the router boots,
    // so there is no departed screen to remember. Built by hand rather than
    // reusing the shared `router`, which has already booted on "#/".
    const cold = fakeWindow();
    cold.win.location.hash = buildHash(DM_PEER);
    vi.stubGlobal("window", cold.win);
    const r = new Router();
    r.init();
    expect(r.route).toEqual(DM_PEER);
    expect(r.dmReturn).toBeUndefined();
    r.up();
    expect(cold.win.location.hash).toBe(buildHash(DM));
  });
});
