import { describe, it, expect } from "vitest";
import { Store } from "../store/db.js";
import { JobRunner } from "./jobs.js";

function fixedClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("JobRunner (spec §9.2)", () => {
  it("runs a job once and marks it done; duplicate enqueue is idempotent", async () => {
    const store = new Store();
    const clock = fixedClock();
    const runner = new JobRunner(store, { now: clock.now });
    let runs = 0;
    runner.register("noop", async () => {
      runs++;
    });
    runner.enqueue("noop", "key-1", {});
    runner.enqueue("noop", "key-1", {}); // same dedupe key → ignored
    await runner.drain();
    expect(runs).toBe(1);
    expect(store.pendingJobCount()).toBe(0);
  });

  it("retries with exponential backoff, then poisons after max attempts", async () => {
    const store = new Store();
    const clock = fixedClock();
    const runner = new JobRunner(store, { now: clock.now, maxAttempts: 3, baseBackoffMs: 100 });
    let attempts = 0;
    runner.register("flaky", async () => {
      attempts++;
      throw new Error("boom");
    });
    runner.enqueue("flaky", "k", {});

    await runner.drain(); // attempt 1 → fails, backoff 100
    expect(attempts).toBe(1);
    // Not yet runnable (backoff in the future).
    await runner.drain();
    expect(attempts).toBe(1);

    clock.advance(100);
    await runner.drain(); // attempt 2 → fails, backoff 200
    expect(attempts).toBe(2);
    clock.advance(200);
    await runner.drain(); // attempt 3 → poison
    expect(attempts).toBe(3);

    clock.advance(10_000);
    await runner.drain(); // poison never runs again
    expect(attempts).toBe(3);
    expect(store.poisonJobs()).toHaveLength(1);
  });

  it("a handler can enqueue follow-up jobs", async () => {
    const store = new Store();
    const runner = new JobRunner(store, { now: () => 0 });
    const order: string[] = [];
    runner.register("a", async (_p, { enqueue }) => {
      order.push("a");
      enqueue("b", "b-key", {});
    });
    runner.register("b", async () => order.push("b"));
    runner.enqueue("a", "a-key", {});
    await runner.drain();
    expect(order).toEqual(["a", "b"]);
  });
});
