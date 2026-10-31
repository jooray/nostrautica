import { describe, expect, it } from "vitest";
import { retryInBackground } from "./background-retry.js";

/** A manual timer queue: the test decides when each scheduled retry fires. */
function manualTimers() {
  const pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false };
      pending.push(t);
      return { cancel: () => void (t.cancelled = true) };
    },
    async fireNext() {
      const t = pending.shift()!;
      if (!t.cancelled) t.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      return t.ms;
    },
  };
}
const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("retryInBackground (audit O-5)", () => {
  it("backs off, logs the first failure of a streak once, and the success with the count", async () => {
    const timers = manualTimers();
    const lines: string[] = [];
    let calls = 0;
    const r = retryInBackground({
      label: "announce",
      attempt: async () => {
        if (++calls < 4) throw new Error("publish timed out");
      },
      delaysMs: [10, 20, 40],
      log: (m) => lines.push(m),
      setTimer: timers.setTimer,
    });
    await expect(r.first).resolves.toBe(false);
    await tick();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/announce failed: publish timed out — retrying in the background, next in 0 s/);
    const gaps = [await timers.fireNext(), await timers.fireNext(), await timers.fireNext()];
    expect(gaps).toEqual([10, 20, 40]);
    await expect(r.settled).resolves.toBe(true);
    expect(lines).toHaveLength(2); // no line per failed retry
    expect(lines[1]).toBe("announce succeeded on attempt 4 after 3 failure(s)");
  });

  it("says nothing when the first attempt works", async () => {
    const lines: string[] = [];
    const r = retryInBackground({ label: "x", attempt: async () => {}, delaysMs: [10], log: (m) => lines.push(m) });
    await expect(r.first).resolves.toBe(true);
    await expect(r.settled).resolves.toBe(true);
    expect(lines).toEqual([]);
  });

  it("gives up after maxAttempts and says so once", async () => {
    const timers = manualTimers();
    const lines: string[] = [];
    const r = retryInBackground({
      label: "x",
      attempt: async () => {
        throw new Error("nope");
      },
      delaysMs: [10],
      maxAttempts: 3,
      log: (m) => lines.push(m),
      setTimer: timers.setTimer,
    });
    await tick();
    await timers.fireNext();
    await timers.fireNext();
    await expect(r.settled).resolves.toBe(false);
    expect(timers.pending).toHaveLength(0);
    expect(lines).toEqual([expect.stringMatching(/x failed: nope/), "x gave up after 3 attempt(s): nope"]);
  });

  it("stop() cancels the pending retry", async () => {
    const timers = manualTimers();
    let calls = 0;
    const r = retryInBackground({
      label: "x",
      attempt: async () => {
        calls++;
        throw new Error("nope");
      },
      delaysMs: [10],
      log: () => {},
      setTimer: timers.setTimer,
    });
    await tick();
    r.stop();
    await timers.fireNext();
    expect(calls).toBe(1);
    await expect(r.settled).resolves.toBe(false);
  });
});
