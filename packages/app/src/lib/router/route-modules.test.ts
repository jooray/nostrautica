/**
 * Offline route-module warming list vs the route registry (audit U7). The
 * offline pack promises certain participant destinations work offline; if its
 * warming list ever drifts from the real lazy routes, the pack would silently
 * warm the wrong (or no) chunk. These invariants pin the list to the registry.
 */
import { describe, it, expect } from "vitest";
import {
  lazyRouteLoaders,
  PARTICIPANT_OFFLINE_ROUTES,
  CRITICAL_PARTICIPANT_ROUTES,
  warmRouteModules,
  type LazyRouteName,
} from "./route-modules.js";

// Eager routes ride the entry chunk — they must NEVER appear as a lazy loader
// (that would double-bundle them and mislead the warmer).
const EAGER_ROUTES = new Set([
  "home",
  "login",
  "event",
  "join",
  "attendees",
  "attendee",
  "matches",
  "me",
  "eventMore",
  "notFound",
]);

describe("route-modules registry (audit U7)", () => {
  it("every participant-offline route has a real loader in the registry", () => {
    const known = new Set(Object.keys(lazyRouteLoaders));
    for (const name of PARTICIPANT_OFFLINE_ROUTES) {
      expect(known.has(name), `missing loader for ${name}`).toBe(true);
      expect(typeof lazyRouteLoaders[name]).toBe("function");
    }
  });

  it("critical boot-warm routes are a subset of the offline routes", () => {
    const offline = new Set<LazyRouteName>(PARTICIPANT_OFFLINE_ROUTES);
    for (const name of CRITICAL_PARTICIPANT_ROUTES) {
      expect(offline.has(name), `${name} warmed on boot but not in offline pack`).toBe(true);
    }
  });

  it("no lazy loader collides with an eager (entry-chunk) route", () => {
    for (const name of Object.keys(lazyRouteLoaders)) {
      expect(EAGER_ROUTES.has(name), `${name} is eager but listed as lazy`).toBe(false);
    }
  });

  it("promises exactly the participant destinations, not organizer/settings/dm/chat", () => {
    // Guards against accidentally warming heavy organizer chunks in a
    // participant-facing offline pack.
    expect([...PARTICIPANT_OFFLINE_ROUTES].sort()).toEqual(
      ["myProfile", "post", "posts", "record", "talk", "talks"].sort(),
    );
    for (const excluded of ["admin", "eventSettings", "settings", "dm", "dmPeer", "chat"]) {
      expect(PARTICIPANT_OFFLINE_ROUTES).not.toContain(excluded);
    }
  });

  it("warmRouteModules resolves to 0 for an empty list without importing anything", async () => {
    await expect(warmRouteModules([])).resolves.toBe(0);
  });
});
