import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("stopClaiming halts new claims but the drain returns cleanly (graceful shutdown)", async () => {
    const store = new Store();
    const runner = new JobRunner(store, { now: fixedClock().now });
    let runs = 0;
    runner.register("noop", async () => {
      runs++;
    });
    runner.enqueue("noop", "a", {});
    runner.enqueue("noop", "b", {});
    runner.stopClaiming();
    await runner.drain();
    // No new jobs were claimed after stopClaiming; both remain pending.
    expect(runs).toBe(0);
    expect(store.pendingJobCount()).toBe(2);
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

  it("the DEFAULT schedule is a long tail (COORD-15): quick retries, then ~hourly, poison only after ~3 days", async () => {
    const store = new Store();
    const clock = fixedClock();
    const runner = new JobRunner(store, { now: clock.now });
    let attempts = 0;
    runner.register("flaky", async () => {
      attempts++;
      throw new Error("boom");
    });
    runner.enqueue("flaky", "k", {});

    // Quick early retries: 1s, 10s, 100s.
    await runner.drain();
    expect(attempts).toBe(1);
    for (const backoff of [1_000, 10_000, 100_000]) {
      clock.advance(backoff);
      await runner.drain();
    }
    expect(attempts).toBe(4);
    // Then ~hourly — still retrying 5 hours in, NOT poisoned at ~31s like before.
    clock.advance(5 * 60 * 60_000);
    await runner.drain();
    expect(attempts).toBeGreaterThan(4);
    expect(store.poisonJobs()).toHaveLength(0);
    // The tail spans ~3 days before poisoning (advance past each backoff in steps —
    // a frozen clock only makes the NEXT due attempt runnable per drain).
    for (let i = 0; i < 60 && store.poisonJobs().length === 0; i++) {
      clock.advance(4 * 60 * 60_000);
      await runner.drain();
    }
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

  it("surfaces a poison via the onPoison callback (Q12)", async () => {
    const store = new Store();
    const clock = fixedClock();
    const poisoned: any[] = [];
    const runner = new JobRunner(store, {
      now: clock.now, maxAttempts: 1, baseBackoffMs: 1,
      onPoison: (info) => poisoned.push(info),
    });
    runner.register("boom", async () => {
      throw new Error("output failed the ai_profile contract");
    });
    runner.enqueue("boom", "k", { coordinate: "c", pubkey: "p" });
    await runner.drain();
    expect(poisoned).toHaveLength(1);
    expect(poisoned[0]).toMatchObject({ type: "boom", attempts: 1 });
    expect(poisoned[0].payload).toEqual({ coordinate: "c", pubkey: "p" });
  });
});

describe("job leases and crash recovery (audit H1)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tmpDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "nostrautica-jobs-"));
    tmpDirs.push(dir);
    return join(dir, "jobs.sqlite");
  }

  it("a job claimed but not completed (crash) is recovered after its lease expires", async () => {
    const path = tmpDbPath();

    // First process: claim a job under a lease, then "crash" (never complete).
    const s1 = new Store(path);
    s1.enqueueJob("work", "k1", { n: 1 });
    const claimed = s1.claimNextJob(1000, "worker-A", 60_000);
    expect(claimed?.state).toBe("running");
    // Still counted, but no worker can complete it — it's leased to the dead worker.
    expect(s1.pendingJobCount()).toBe(1);
    s1.close();

    // Second process reopens the SAME on-disk DB after the lease has expired.
    const s2 = new Store(path);
    const clock = fixedClock(1000 + 61_000);
    let ran = 0;
    const runner = new JobRunner(s2, { now: clock.now });
    runner.register("work", async () => {
      ran++;
    });
    // Startup sweep reclaims the stranded lease, then the job runs to completion.
    expect(runner.recoverStrandedJobs()).toBe(1);
    await runner.drain();
    expect(ran).toBe(1);
    expect(s2.pendingJobCount()).toBe(0);
    s2.close();
  });

  it("claimNextJob reclaims an expired-running job even without an explicit sweep", async () => {
    const store = new Store();
    store.enqueueJob("work", "k", {});
    store.claimNextJob(1000, "A", 5000); // leased to A until 6000
    // Before expiry: nothing new is claimable.
    expect(store.claimNextJob(2000, "B", 5000)).toBeUndefined();
    // After expiry: B can take it over.
    const taken = store.claimNextJob(7000, "B", 5000);
    expect(taken?.worker_token).toBe("B");
  });

  it("a stale lease owner cannot overwrite the new owner's result", () => {
    const store = new Store();
    store.enqueueJob("work", "k", {});
    const a = store.claimNextJob(1000, "A", 1000)!;
    // A's lease expires; B re-claims.
    const b = store.claimNextJob(3000, "B", 1000)!;
    expect(b.id).toBe(a.id);
    // A finishing late must NOT complete the job it lost.
    expect(store.completeJob(a.id, "A")).toBe(false);
    // B legitimately completes it.
    expect(store.completeJob(b.id, "B")).toBe(true);
    expect(store.pendingJobCount()).toBe(0);
  });

  it("lease expiry / recovery does not consume a retry attempt", () => {
    const store = new Store();
    store.enqueueJob("work", "k", {});
    const c = store.claimNextJob(1000, "A", 1000)!;
    expect(c.attempts).toBe(0);
    store.reclaimExpiredLeases(3000); // A crashed
    const c2 = store.claimNextJob(3000, "B", 1000)!;
    expect(c2.attempts).toBe(0); // still zero — no retry burned by the crash
  });

  it("heartbeats a long-running job so a second worker can't reclaim its lease (P0-6)", async () => {
    const store = new Store();
    // Real wall-clock `now` (default) so the heartbeat timer and the lease math
    // agree. Short lease so the test is fast; the handler runs well past it.
    const runner = new JobRunner(store, { leaseMs: 90, maxAttempts: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    runner.register("slow", async () => {
      await gate;
    });
    store.enqueueJob("slow", "k", {});
    const running = runner.runOne(); // claims the job and parks on the gate

    // Park well past 2× the lease. With the heartbeat the lease is continuously
    // extended; pre-fix (no heartbeat) it would have lapsed at ~90ms.
    await new Promise((r) => setTimeout(r, 250));
    const stolen = store.claimNextJob(Date.now(), "worker-2", 90);
    expect(stolen).toBeUndefined(); // still owned by the original worker

    release();
    await running;
    expect(store.pendingJobCount()).toBe(0); // completed by the original owner
  });
});

describe("shutdown abort (audit C11)", () => {
  it("a blocked handler observes the abort; drain resolves only after it does", async () => {
    const store = new Store();
    const runner = new JobRunner(store);
    let observed = false;
    let handlerStarted = false;
    runner.register("block", (_p, { signal }) =>
      new Promise<void>((resolve) => {
        handlerStarted = true;
        signal.addEventListener("abort", () => {
          observed = true;
          resolve();
        });
      }),
    );
    runner.enqueue("block", "k", {});
    const drainP = runner.drain();
    // Let the handler start and block.
    await new Promise((r) => setTimeout(r, 10));
    expect(handlerStarted).toBe(true);
    expect(observed).toBe(false);
    // The graceful window "expired": abort, then AWAIT confirmed cancellation. Only
    // after this resolves may a real shutdown close transport/store/lock.
    runner.abort();
    await drainP;
    expect(observed).toBe(true);
  });

  it("a handler that throws on abort leaves the job claimable (no retry consumed)", async () => {
    const store = new Store();
    const runner = new JobRunner(store);
    runner.register("throwy", async (_p, { signal }) => {
      await new Promise((r) => setTimeout(r, 5));
      signal.throwIfAborted();
    });
    runner.enqueue("throwy", "k", {});
    const drainP = runner.drain();
    runner.abort();
    await drainP;
    // The aborted job was neither poisoned nor retried — it is still claimable
    // (left 'running' with its lease for the next start's stranded-lease recovery).
    expect(store.poisonJobs()).toHaveLength(0);
    expect(store.pendingJobCount()).toBe(1);
  });
});

/**
 * Observability of work that never runs (production incident 2026-07-24). Every
 * one of these paths used to end in silence, which is why six minutes of a dead
 * pipeline looked identical to six minutes of a slow one.
 */
describe("JobRunner — a job that does not run says so", () => {
  it("warns when an enqueue is discarded by an already-FINISHED dedupe key", async () => {
    const store = new Store();
    const runner = new JobRunner(store, { now: fixedClock().now });
    runner.register("work", async () => {});
    runner.enqueue("work", "k", {});
    await runner.drain(); // the row is now 'done', and keeps its key for 30 days

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Same key again: INSERT OR IGNORE discards it, and NOTHING will ever run it.
    expect(runner.enqueue("work", "k", {})).toBe("done");
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(
      /\[job\] work enqueue DISCARDED — dedupe key already 'done': k — this work will NOT run/,
    );
    warn.mockRestore();
  });

  it("stays quiet when an enqueue merely coalesces onto live work", () => {
    const store = new Store();
    const runner = new JobRunner(store, { now: fixedClock().now });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    runner.enqueue("work", "k", {});
    // Coalescing onto a still-pending row is the intended dedupe behavior — the
    // work DOES run, so a warning here would be noise on every normal redelivery.
    expect(runner.enqueue("work", "k", {})).toBe("pending");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("logs the poison when a job type has no registered handler", async () => {
    const store = new Store();
    const runner = new JobRunner(store, { now: fixedClock().now });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.enqueueJob("ghost", "k", {});
    await runner.drain();
    expect(store.poisonJobs()).toHaveLength(1);
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(
      /\[job\] ghost #\d+ POISONED: no handler registered/,
    );
    warn.mockRestore();
  });

  it("reports a stalled worker on the queue-depth line (and stays silent when idle)", async () => {
    const store = new Store();
    const clock = fixedClock();
    const runner = new JobRunner(store, { now: clock.now });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    // Nothing queued, nothing running: no output at all, so a healthy idle daemon
    // adds no log volume.
    runner.reportQueueDepth();
    expect(out).not.toHaveBeenCalled();

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    runner.register("slow", async () => {
      await gate;
    });
    runner.enqueue("slow", "k", {});
    runner.enqueue("slow", "k2", {}); // stays pending behind the stalled one
    const running = runner.runOne();
    await Promise.resolve();

    // THE line the incident needed: which job is stuck, and for how long.
    clock.advance(340_000);
    out.mockClear();
    runner.reportQueueDepth();
    const line = out.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toMatch(/\[jobs\] queue: 1 pending, 1 running, 0 waiting \(parked\), 0 poisoned/);
    expect(line).toMatch(/worker: slow #\d+ for 340s/);

    release();
    await running;
    out.mockRestore();
  });
});
