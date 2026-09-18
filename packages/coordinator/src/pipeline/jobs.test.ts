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

  it("runs a newcomer's own matching ahead of reverse work already queued", async () => {
    // The Plan B shape (2026-09-11): someone's forward batch finishes and enqueues
    // the publish that shows THEM their list — but that row is created after the
    // reverse batches, so in pure id order the 30ms publish waited out three LLM
    // calls. And a second arrival's whole pipeline waited behind the first
    // person's reverse work, which nobody is looking at.
    const store = new Store();
    const runner = new JobRunner(store, { now: fixedClock().now });
    const order: string[] = [];
    for (const type of ["score_batch", "score_reverse_batch", "publish_matches", "process_attendee"]) {
      runner.register(type, async (p: { who: string }) => {
        order.push(`${type}:${p.who}`);
      });
    }
    // Newcomer A's recompute: forward first, then reverse (what match_recompute does).
    runner.enqueue("score_batch", "a-fwd", { who: "A" });
    runner.enqueue("score_reverse_batch", "a-rev-1", { who: "A" });
    runner.enqueue("score_reverse_batch", "a-rev-2", { who: "A" });
    // A's forward batch would enqueue this only once it finished — it is queued
    // last, and before this change it ran last.
    runner.enqueue("publish_matches", "a-pub", { who: "A" });
    // B walks in while A's reverse work is still queued.
    runner.enqueue("process_attendee", "b-proc", { who: "B" });
    await runner.drain();

    expect(order).toEqual([
      // A's list is published the moment there is something to publish …
      "publish_matches:A",
      "score_batch:A",
      // … B's pipeline starts while A's cross-updates are still queued …
      "process_attendee:B",
      // … and the work nobody is watching for runs last.
      "score_reverse_batch:A",
      "score_reverse_batch:A",
    ]);
  });

  describe("scoring runs two-wide; everything else stays one at a time", () => {
    /** A handler that reports its own overlap window, so a lane breach is visible. */
    function tracker() {
      const live = new Map<string, number>();
      const peak = new Map<string, number>();
      let peakTotal = 0;
      return {
        peak,
        peakTotal: () => peakTotal,
        async run(type: string, ticks = 2) {
          live.set(type, (live.get(type) ?? 0) + 1);
          const total = [...live.values()].reduce((a, b) => a + b, 0);
          peak.set(type, Math.max(peak.get(type) ?? 0, live.get(type)!));
          peakTotal = Math.max(peakTotal, total);
          for (let i = 0; i < ticks; i++) await Promise.resolve();
          await new Promise((r) => setTimeout(r, 1));
          live.set(type, live.get(type)! - 1);
        },
      };
    }

    it("runs two score batches at once", async () => {
      const store = new Store();
      const runner = new JobRunner(store, { now: fixedClock().now, scoreConcurrency: 2 });
      const t = tracker();
      runner.register("score_batch", () => t.run("score_batch"));
      for (let i = 0; i < 6; i++) runner.enqueue("score_batch", `s${i}`, {});
      await runner.drain();
      expect(t.peak.get("score_batch")).toBe(2);
      expect(store.pendingJobCount()).toBe(0);
    });

    it("never runs two jobs of any other type at once", async () => {
      // The lane that matters: process_attendee downloads media against a byte
      // budget and fills content-addressed caches across awaits, chat jobs mutate
      // MLS group state. None of that was written for two handlers, and the pool
      // must not be what discovers it.
      const store = new Store();
      const runner = new JobRunner(store, { now: fixedClock().now, scoreConcurrency: 2 });
      const t = tracker();
      for (const type of ["process_attendee", "chat_sync_member", "publish_matches"]) {
        runner.register(type, () => t.run(type));
      }
      for (let i = 0; i < 4; i++) {
        runner.enqueue("process_attendee", `p${i}`, {});
        runner.enqueue("chat_sync_member", `c${i}`, {});
        runner.enqueue("publish_matches", `m${i}`, {});
      }
      await runner.drain();
      expect(t.peak.get("process_attendee")).toBe(1);
      expect(t.peak.get("chat_sync_member")).toBe(1);
      expect(t.peak.get("publish_matches")).toBe(1);
      // And the serial lane is ONE lane: two different serial types never overlap
      // either, so a chat job can't run beside an attendee job.
      expect(t.peakTotal()).toBe(1);
      expect(store.pendingJobCount()).toBe(0);
    });

    it("a serial job and a score batch can share the wall clock", async () => {
      const store = new Store();
      const runner = new JobRunner(store, { now: fixedClock().now, scoreConcurrency: 2 });
      const t = tracker();
      runner.register("process_attendee", () => t.run("process_attendee", 6));
      runner.register("score_batch", () => t.run("score_batch", 6));
      runner.enqueue("process_attendee", "p", {});
      runner.enqueue("score_batch", "s", {});
      await runner.drain();
      expect(t.peakTotal()).toBe(2);
    });

    it("a worker whose lane is busy waits for it instead of ending the drain", async () => {
      // Without the wait, the second worker returns the instant the serial lane is
      // taken — and `drain` would then run one-wide for as long as that job lasts,
      // which for a scoring call is over two minutes.
      const store = new Store();
      const runner = new JobRunner(store, { now: fixedClock().now, scoreConcurrency: 2 });
      const order: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      runner.register("process_attendee", async () => {
        order.push("serial-start");
        await held;
        order.push("serial-end");
      });
      runner.register("score_batch", async () => {
        order.push("score");
      });
      runner.enqueue("process_attendee", "p", {});
      const drain = runner.drain();
      await new Promise((r) => setTimeout(r, 5));
      // Queued only AFTER the drain started and the serial lane was already held.
      runner.enqueue("score_batch", "s", {});
      await new Promise((r) => setTimeout(r, 60));
      release();
      await drain;
      // The score job ran while the serial job was still blocked.
      expect(order).toEqual(["serial-start", "score", "serial-end"]);
    });

    it("awaits every worker and rethrows, so a store failure cannot orphan one", async () => {
      // An un-awaited worker rejection reaches unhandledRejection, which this
      // daemon turns into exit(1) — with the other worker still writing.
      const store = new Store();
      const runner = new JobRunner(store, { now: fixedClock().now, scoreConcurrency: 2 });
      let finished = false;
      runner.register("score_batch", async (p: { boom?: boolean }) => {
        if (p.boom) {
          // Not a handler error (those are caught and retried) — a claim-path
          // failure, which is what propagates out of runOne.
          store.close();
          return;
        }
        await new Promise((r) => setTimeout(r, 20));
        finished = true;
      });
      runner.enqueue("score_batch", "slow", {});
      runner.enqueue("score_batch", "boom", { boom: true });
      await expect(runner.drain()).rejects.toThrow();
      expect(finished).toBe(true); // the sibling was awaited, not abandoned
    });
  });

  it("keeps id order inside a scheduling class", async () => {
    const store = new Store();
    const runner = new JobRunner(store, { now: fixedClock().now });
    const order: number[] = [];
    runner.register("score_reverse_batch", async (p: { n: number }) => {
      order.push(p.n);
    });
    for (const n of [1, 2, 3]) runner.enqueue("score_reverse_batch", `r${n}`, { n });
    await runner.drain();
    expect(order).toEqual([1, 2, 3]);
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

  // Prod 2026-07-31: two attendees of a live event had process_attendee fail on
  // Venice 402s. Their ai_profile stayed a hollow {"summary":"","skills":[],…},
  // which scoring correctly refuses to match on, so they silently had no matches
  // while everyone around them did. Running out of retries on a billing failure
  // means the outage outlasted the tail — not that the work should be discarded.
  it("parks instead of poisoning when the failure is a depleted provider account", async () => {
    const store = new Store();
    const clock = fixedClock();
    const runner = new JobRunner(store, {
      now: clock.now,
      maxAttempts: 2,
      baseBackoffMs: 100,
      poisonExempt: (err) => (String(err).includes("insufficient balance") ? "out of credit" : undefined),
    });
    let attempts = 0;
    runner.register("paid", async () => {
      attempts++;
      throw new Error("provider billing: insufficient balance (402)");
    });
    runner.enqueue("paid", "k", { coordinate: "31923:abc:evt" });

    await runner.drain(); // attempt 1 → ordinary retry
    clock.advance(100);
    await runner.drain(); // attempt 2 → would poison, parks instead
    expect(attempts).toBe(2);
    expect(store.poisonJobs()).toHaveLength(0);
    expect(store.waitingJobCount()).toBe(1);

    // Parked work stays put no matter how long we wait — it is not a retry.
    clock.advance(10_000_000);
    await runner.drain();
    expect(attempts).toBe(2);

    // An organizer reprocess revives it with a WHOLE fresh tail rather than one
    // doomed call: attempts were reset when it parked, so this failure is an
    // ordinary retry (still pending, still not poisoned) and the account has
    // another three days to be topped up.
    store.resumeWaitingJobs("31923:abc:evt");
    await runner.drain();
    expect(attempts).toBe(3);
    expect(store.poisonJobs()).toHaveLength(0);
    expect(store.waitingJobCount()).toBe(0);
    expect(store.pendingJobCount()).toBe(1);
  });

  it("a park NOTIFIES, exactly like a poison does (PIPE-N-4)", async () => {
    // The park path returned without calling `onPoison`, so nothing was published
    // at all: the organizer's Admin view showed nothing wrong, and the attendee's
    // screen said "processing" indefinitely. A park is reached only after the
    // three-day tail ran out — it means "this outage outlasted every retry and now
    // needs a human" — which is the same fact to a reader as a poison.
    const store = new Store();
    const clock = fixedClock();
    const notified: { parked?: { reason: string }; attempts: number }[] = [];
    const runner = new JobRunner(store, {
      now: clock.now,
      maxAttempts: 2,
      baseBackoffMs: 100,
      onPoison: (info) => notified.push(info),
      poisonExempt: (err) => (String(err).includes("insufficient balance") ? "out of credit" : undefined),
    });
    runner.register("paid", async () => {
      throw new Error("provider billing: insufficient balance (402)");
    });
    runner.enqueue("paid", "k", { coordinate: "31923:abc:evt" });
    await runner.drain();
    clock.advance(100);
    await runner.drain();

    expect(store.waitingJobCount()).toBe(1); // still parked, not discarded
    expect(notified).toHaveLength(1);
    expect(notified[0]!.parked?.reason).toBe("out of credit");
    expect(notified[0]!.attempts).toBe(2);
  });

  it("still poisons a failure that is genuinely about the job, not the account", async () => {
    const store = new Store();
    const clock = fixedClock();
    const runner = new JobRunner(store, {
      now: clock.now,
      maxAttempts: 2,
      baseBackoffMs: 100,
      poisonExempt: (err) => (String(err).includes("insufficient balance") ? "out of credit" : undefined),
    });
    runner.register("bad", async () => {
      throw new Error("output failed the profile_translation contract");
    });
    runner.enqueue("bad", "k", {});
    await runner.drain();
    clock.advance(100);
    await runner.drain();
    expect(store.poisonJobs()).toHaveLength(1);
    expect(store.waitingJobCount()).toBe(0);
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
    // (released back to `pending`, runnable at once; see the next case).
    expect(store.poisonJobs()).toHaveLength(0);
    expect(store.pendingJobCount()).toBe(1);
  });

  it("an aborted job is claimable IMMEDIATELY on restart, not after the lease expires", async () => {
    // The deploy case. The abort branch used to leave the row `running` and call
    // that "claimable for restart" — but both recovery paths (claimNextJob's
    // stranded arm and reclaimExpiredLeases) require `lease_until <= now`, and the
    // heartbeat had just pushed the lease to now + 5 minutes. So a deploy landing
    // mid-job idled that attendee's pipeline for up to five minutes past the
    // restart while the fresh daemon logged "recovered 0 stranded job(s)".
    const store = new Store();
    const clock = fixedClock();
    const runner = new JobRunner(store, { now: clock.now, leaseMs: 5 * 60_000 });
    runner.register("slow", async (_p, { signal }) => {
      await new Promise((r) => setTimeout(r, 5));
      signal.throwIfAborted();
    });
    runner.enqueue("slow", "k", { coordinate: "c" });
    const drainP = runner.drain();
    runner.abort();
    await drainP;

    // What a restarting daemon does, at the SAME instant (no clock advance).
    const fresh = new JobRunner(store, { now: clock.now, leaseMs: 5 * 60_000 });
    expect(fresh.recoverStrandedJobs()).toBe(0); // nothing stranded — it was released
    let ran = 0;
    fresh.register("slow", async () => {
      ran++;
    });
    await fresh.drain();
    expect(ran).toBe(1);

    const row = store.claimNextJob(clock.now(), "probe", 1000);
    expect(row).toBeUndefined(); // it completed; nothing left to claim
  });

  it("the release consumes no retry and clears the lease", async () => {
    const store = new Store();
    const clock = fixedClock();
    const runner = new JobRunner(store, { now: clock.now, maxAttempts: 3, baseBackoffMs: 100 });
    runner.register("slow", async (_p, { signal }) => {
      await new Promise((r) => setTimeout(r, 5));
      signal.throwIfAborted();
    });
    runner.enqueue("slow", "k", {});
    const drainP = runner.drain();
    runner.abort();
    await drainP;

    const row = (store as any).db.prepare("SELECT * FROM jobs WHERE dedupe_key = 'k'").get();
    expect(row.state).toBe("pending");
    expect(row.attempts).toBe(0); // a shutdown is not the job's fault
    expect(row.next_run_at).toBe(0); // no backoff — run it now
    expect(row.lease_until).toBeNull();
    expect(row.worker_token).toBeNull();
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

/**
 * Per-error retry budgets (2026-09-04 audit).
 *
 * The default schedule spends ~26 attempts over three days. That is right for a
 * failure that may clear on its own and exactly wrong for a deterministic one:
 * the same prompt and model produce the same malformed shape every time, so the
 * tail is three fully billed days of re-asking an answered question.
 *
 * Prod at the time of the audit held two attendees poisoned since mid-July on
 * error_category=provider_contract, plus one that cleared only after 27 attempts.
 */
describe("JobRunner — a deterministic failure must not buy the full paid tail", () => {
  class DeterministicError extends Error {}

  it("poisons a classified error at its short budget, not at maxAttempts", async () => {
    const store = new Store();
    const clock = fixedClock();
    const poisoned: number[] = [];
    const runner = new JobRunner(store, {
      now: clock.now,
      onPoison: (info) => poisoned.push(info.attempts),
      retryBudget: (err) => (err instanceof DeterministicError ? 3 : undefined),
    });
    let calls = 0;
    runner.register("det", async () => {
      calls++;
      throw new DeterministicError("output was not valid JSON");
    });
    runner.enqueue("det", "k", {});
    for (let i = 0; i < 30; i++) {
      await runner.drain();
      clock.advance(5 * 24 * 60 * 60_000); // past any backoff
    }
    expect(calls).toBe(3);
    expect(poisoned).toEqual([3]);
  });

  it("leaves an unclassified error on the long tail", async () => {
    const store = new Store();
    const clock = fixedClock();
    const runner = new JobRunner(store, {
      now: clock.now,
      retryBudget: (err) => (err instanceof DeterministicError ? 3 : undefined),
    });
    let calls = 0;
    runner.register("transient", async () => {
      calls++;
      throw new Error("relay unreachable");
    });
    runner.enqueue("transient", "k", {});
    for (let i = 0; i < 6; i++) {
      await runner.drain();
      clock.advance(5 * 60 * 60_000);
    }
    expect(calls).toBeGreaterThan(3);
  });

  it("can only tighten the budget, never extend past maxAttempts", async () => {
    const store = new Store();
    const clock = fixedClock();
    const runner = new JobRunner(store, {
      now: clock.now,
      maxAttempts: 2,
      baseBackoffMs: 1,
      retryBudget: () => 99,
    });
    let calls = 0;
    runner.register("capped", async () => {
      calls++;
      throw new Error("boom");
    });
    runner.enqueue("capped", "k", {});
    for (let i = 0; i < 10; i++) {
      await runner.drain();
      clock.advance(60_000);
    }
    expect(calls).toBe(2);
  });
});
