/**
 * App-1: the controller latch must skip ONLY the first-install claim and reload
 * on every genuine later update — including a second deploy in the same tab, the
 * exact case the old single-`hadController` capture missed.
 */
import { describe, it, expect } from "vitest";
import { ControllerLatch } from "./pwa-latch.js";

describe("ControllerLatch (App-1)", () => {
  it("fresh install: skips the initial claim, reloads on the next update, once", () => {
    const latch = new ControllerLatch(false); // page not yet controlled
    expect(latch.shouldReload()).toBe(false); // initial install claim — no reload
    expect(latch.shouldReload()).toBe(true); // a real second deploy — reload
    expect(latch.shouldReload()).toBe(false); // already reloading — ignore the rest
  });

  it("already controlled at startup: the first controllerchange is a real update", () => {
    const latch = new ControllerLatch(true);
    expect(latch.shouldReload()).toBe(true);
    expect(latch.shouldReload()).toBe(false);
  });
});
