/**
 * Job runner (spec §9.2). Each pipeline stage is an idempotent job with a dedupe
 * key = hash of stage inputs, retried with exponential backoff (max attempts,
 * then a poison state surfaced to the organizer). Because every stage is keyed by
 * its input hash and writes results into content-addressed caches, a restart
 * mid-pipeline never re-bills (IMPLEMENTATION_PLAN §3.11).
 */
import { randomUUID } from "node:crypto";
import type { Store, JobRow } from "../store/db.js";

export type JobHandler = (payload: any, ctx: { enqueue: EnqueueFn }) => Promise<void>;
export type EnqueueFn = (type: string, dedupeKey: string, payload: unknown) => void;

/**
 * A handler throws this to PARK its job (spec §9 billing/budget gates, H-2) rather
 * than fail it: the job moves to a distinct `waiting` state that `claimNextJob`
 * never claims, so blocked paid work is coalesced (parked once) instead of
 * retry-spinning against a hard billing/budget block. It consumes no retry and can
 * never poison; `store.resumeWaitingJobs` re-enqueues it when the block clears.
 */
export class ParkJobError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ParkJobError";
  }
}

/** A poisoned job, surfaced so the coordinator can notify the organizer (Q12). */
export interface PoisonInfo {
  type: string;
  payload: any;
  attempts: number;
  error: string;
}

export interface JobRunnerOptions {
  /** Legacy knobs: exponential doubling `baseBackoffMs * 2^(attempt-1)`, capped
   *  at `maxAttempts` tries. Overridden by `backoffScheduleMs` when given; used
   *  as the schedule's whole shape when either is set without it (tests rely on
   *  this exact formula for fast, deterministic fixtures). */
  maxAttempts?: number;
  baseBackoffMs?: number;
  /** Explicit per-attempt backoff (ms), most recent entry repeats once exhausted.
   *  Poison fires once every entry has been tried and failed once more. Defaults
   *  to a long tail so a transient outage (a flaky provider response, a
   *  depleted balance that gets topped up hours later) resolves on its own
   *  instead of poisoning in under 20s and waiting on a human to click retry
   *  (user feedback 2026-07-21). */
  backoffScheduleMs?: number[];
  /** Lease duration for a claimed job (audit H1). Default 5 minutes. */
  leaseMs?: number;
  now?: () => number;
  /** Called when a job exhausts its retries and enters the poison state (Q12). */
  onPoison?: (info: PoisonInfo) => void;
}

/** 1s, 10s, 100s, six tries ~1h apart, then every 4h until ~3 days have elapsed. */
function buildDefaultBackoffSchedule(): number[] {
  const HOUR = 60 * 60_000;
  const THREE_DAYS = 3 * 24 * HOUR;
  const schedule = [1_000, 10_000, 100_000];
  for (let i = 0; i < 6; i++) schedule.push(HOUR);
  let total = schedule.reduce((a, b) => a + b, 0);
  while (total < THREE_DAYS) {
    schedule.push(4 * HOUR);
    total += 4 * HOUR;
  }
  return schedule;
}

const DEFAULT_BACKOFF_SCHEDULE_MS = buildDefaultBackoffSchedule();

export class JobRunner {
  private handlers = new Map<string, JobHandler>();
  private readonly maxAttempts: number;
  private readonly backoffSchedule: number[];
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly onPoison?: (info: PoisonInfo) => void;

  constructor(private readonly store: Store, opts: JobRunnerOptions = {}) {
    this.backoffSchedule =
      opts.backoffScheduleMs ??
      (opts.maxAttempts !== undefined || opts.baseBackoffMs !== undefined
        ? Array.from({ length: (opts.maxAttempts ?? 5) - 1 }, (_, i) => (opts.baseBackoffMs ?? 1000) * 2 ** i)
        : DEFAULT_BACKOFF_SCHEDULE_MS);
    this.maxAttempts = opts.maxAttempts ?? this.backoffSchedule.length + 1;
    this.leaseMs = opts.leaseMs ?? 5 * 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.onPoison = opts.onPoison;
  }

  /** Backoff for the Nth failed attempt (1-indexed); the last schedule entry repeats. */
  private backoffForAttempt(attempts: number): number {
    if (this.backoffSchedule.length === 0) return 0;
    const idx = Math.min(attempts, this.backoffSchedule.length) - 1;
    return this.backoffSchedule[idx]!;
  }

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  enqueue(type: string, dedupeKey: string, payload: unknown): void {
    this.store.enqueueJob(type, dedupeKey, payload);
  }

  /** Reclaim leases stranded by a crash (audit H1). Call at startup + periodically. */
  recoverStrandedJobs(): number {
    return this.store.reclaimExpiredLeases(this.now());
  }

  /** Set once shutdown begins: `drain` stops claiming NEW jobs (the in-flight job
   *  still finishes) so a graceful stop can await active work and then close. */
  private stopping = false;

  /** Stop claiming new jobs (reliability tail: graceful shutdown drain). The job
   *  currently executing inside `runOne` is awaited by the caller; no new job is
   *  claimed after this. Idempotent. */
  stopClaiming(): void {
    this.stopping = true;
  }

  /** Run one claimable job under a fresh lease. Returns true if a job was processed. */
  async runOne(): Promise<boolean> {
    const token = randomUUID();
    const job = this.store.claimNextJob(this.now(), token, this.leaseMs);
    if (!job) return false;
    await this.execute(job, token);
    return true;
  }

  /** Drain the queue until no runnable jobs remain (bounded to avoid loops). Stops
   *  claiming new jobs once {@link stopClaiming} has been called (graceful shutdown). */
  async drain(maxIterations = 10_000): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      if (this.stopping) return;
      if (!(await this.runOne())) return;
    }
  }

  private async execute(job: JobRow, token: string): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.store.failJob(job.id, job.attempts + 1, this.now(), `no handler for ${job.type}`, true, token);
      return;
    }
    // Heartbeat the lease while the handler runs (audit P0-6). A pipeline handler
    // can download + transcode media, call several models, or score a batch — far
    // longer than the 5-minute lease. Without a heartbeat the lease expires under
    // an alive-but-slow worker and a second worker reclaims the job, duplicating
    // paid work. We extend the lease at a third of its length; a handler that
    // stops heartbeating (a truly dead/hung worker) correctly lets the lease
    // lapse so recovery can reclaim it. The interval is unref'd so it never keeps
    // the process alive on its own.
    const heartbeatMs = Math.max(1, Math.floor(this.leaseMs / 3));
    const heartbeat = setInterval(() => {
      this.store.heartbeatJob(job.id, token, this.now() + this.leaseMs);
    }, heartbeatMs);
    (heartbeat as { unref?: () => void }).unref?.();
    try {
      await handler(JSON.parse(job.payload), {
        enqueue: (t, k, p) => this.enqueue(t, k, p),
      });
      // If our lease expired and another worker took over, completeJob affects 0
      // rows — we discard our result rather than clobber the new owner's state.
      this.store.completeJob(job.id, token);
    } catch (err) {
      // A billing/budget PARK is not a failure: move to `waiting` (coalesced, no
      // retry consumed, never poisons) — resumed when the block clears (H-2).
      if (err instanceof ParkJobError) {
        const parked = this.store.parkJob(job.id, err.message, token);
        if (parked) {
          const t = new Date().toISOString().slice(11, 19);
          console.log(`[${t}] [job] ${job.type} PARKED (waiting): ${err.message.slice(0, 120)}`);
        }
        return;
      }
      const attempts = job.attempts + 1;
      const poison = attempts >= this.maxAttempts;
      const backoff = this.backoffForAttempt(attempts);
      const msg = err instanceof Error ? err.message : String(err);
      const t = new Date().toISOString().slice(11, 19);
      console.warn(
        `[${t}] [job] ${job.type} ${poison ? "POISONED" : `failed (retry ${attempts}/${this.maxAttempts})`}: ${msg.slice(0, 160)}`,
      );
      const owned = this.store.failJob(job.id, attempts, this.now() + backoff, msg, poison, token);
      // Only surface the poison if we still owned the lease (a stale worker whose
      // lease was stolen must not fire a duplicate organizer notification).
      if (poison && owned && this.onPoison) {
        this.onPoison({ type: job.type, payload: safeParse(job.payload), attempts, error: msg });
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
