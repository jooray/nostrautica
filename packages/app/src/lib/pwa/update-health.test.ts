/**
 * The update path is the subsystem whose failures have historically been both
 * silent and multi-day (nginx serving `/app/sw.js` with `expires 1d`,
 * 2026-07-28: clients answered their own update check from cache for up to 24 h
 * and sat on an old shell, with nothing in any console anywhere). These pin the
 * three things that must never be silent again: a registration that failed, a
 * check that threw while online, and a served worker that keeps disagreeing
 * with the bundle running it.
 */
import { describe, it, expect, vi } from "vitest";
import { UpdateHealth, DRIFT_WARN_AFTER, SILENCE_WARN_MS } from "./update-health.js";

const RELEASE = "2026.09.04-abc1234";
/** A stand-in for the generated sw.js: the precache manifest names the release. */
const swFor = (release: string) =>
  `self.__WB_MANIFEST=[{"url":"/app/index.html","revision":"${release}"}];`;

function harness(release = RELEASE, now = () => 1_000_000) {
  const warn = vi.fn();
  return { health: new UpdateHealth(release, warn, now), warn };
}

describe("service-worker drift detection", () => {
  it("stays quiet while the served worker matches this bundle", () => {
    const { health, warn } = harness();
    for (let i = 0; i < 10; i++) health.observeServiceWorkerSource(swFor(RELEASE));
    expect(warn).not.toHaveBeenCalled();
  });

  it("tolerates a deploy in flight — one or two misses are normal", () => {
    const { health, warn } = harness();
    for (let i = 0; i < DRIFT_WARN_AFTER - 1; i++) {
      health.observeServiceWorkerSource(swFor("some-other-release"));
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once on SUSTAINED divergence, not once per poll", () => {
    const { health, warn } = harness();
    const reported: boolean[] = [];
    for (let i = 0; i < DRIFT_WARN_AFTER + 5; i++) {
      reported.push(health.observeServiceWorkerSource(swFor("some-other-release")));
    }
    expect(reported.filter(Boolean)).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(RELEASE);
  });

  it("re-arms after the client catches up, so a later wedge is reported again", () => {
    const { health, warn } = harness();
    for (let i = 0; i < DRIFT_WARN_AFTER; i++) health.observeServiceWorkerSource(swFor("old"));
    expect(warn).toHaveBeenCalledTimes(1);
    health.observeServiceWorkerSource(swFor(RELEASE)); // caught up
    for (let i = 0; i < DRIFT_WARN_AFTER; i++) health.observeServiceWorkerSource(swFor("old"));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does nothing for a dev build, whose release id would match anything", () => {
    const { health, warn } = harness("dev");
    expect(health.comparable).toBe(false);
    for (let i = 0; i < 10; i++) health.observeServiceWorkerSource("anything at all");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("update-check failures are not silent", () => {
  it("says so when a check throws while online", () => {
    const { health, warn } = harness();
    health.noteCheckFailed(new Error("net::ERR_FAILED"), true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the check fails because we are offline", () => {
    const { health, warn } = harness();
    health.noteCheckFailed(new Error("offline"), false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a failed REGISTRATION, which otherwise kills polling for good", () => {
    const { health, warn } = harness();
    expect(health.registrationFailed).toBe(false);
    health.noteRegisterFailed(new Error("SecurityError"));
    expect(health.registrationFailed).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/registration FAILED/);
  });
});

describe("silence watchdog", () => {
  it("warns once after a long stretch with no successful check", () => {
    let clock = 1_000_000;
    const { health, warn } = harness(RELEASE, () => clock);
    expect(health.warnIfSilent()).toBe(false);
    clock += SILENCE_WARN_MS + 1;
    expect(health.warnIfSilent()).toBe(true);
    expect(health.warnIfSilent()).toBe(false); // once per silent stretch
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a successful check re-arms the watchdog", () => {
    let clock = 1_000_000;
    const { health } = harness(RELEASE, () => clock);
    clock += SILENCE_WARN_MS + 1;
    expect(health.warnIfSilent()).toBe(true);
    health.observeServiceWorkerSource(swFor(RELEASE));
    clock += SILENCE_WARN_MS + 1;
    expect(health.warnIfSilent()).toBe(true);
  });
});
