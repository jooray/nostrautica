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

/** A poisoned job, surfaced so the coordinator can notify the organizer (Q12). */
export interface PoisonInfo {
  type: string;
  payload: any;
  attempts: number;
  error: string;
}

export interface JobRunnerOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  /** Lease duration for a claimed job (audit H1). Default 5 minutes. */
  leaseMs?: number;
  now?: () => number;
  /** Called when a job exhausts its retries and enters the poison state (Q12). */
  onPoison?: (info: PoisonInfo) => void;
}

export class JobRunner {
  private handlers = new Map<string, JobHandler>();
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly onPoison?: (info: PoisonInfo) => void;

  constructor(private readonly store: Store, opts: JobRunnerOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1000;
    this.leaseMs = opts.leaseMs ?? 5 * 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.onPoison = opts.onPoison;
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

  /** Run one claimable job under a fresh lease. Returns true if a job was processed. */
  async runOne(): Promise<boolean> {
    const token = randomUUID();
    const job = this.store.claimNextJob(this.now(), token, this.leaseMs);
    if (!job) return false;
    await this.execute(job, token);
    return true;
  }

  /** Drain the queue until no runnable jobs remain (bounded to avoid loops). */
  async drain(maxIterations = 10_000): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      if (!(await this.runOne())) return;
    }
  }

  private async execute(job: JobRow, token: string): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.store.failJob(job.id, job.attempts + 1, this.now(), `no handler for ${job.type}`, true, token);
      return;
    }
    try {
      await handler(JSON.parse(job.payload), {
        enqueue: (t, k, p) => this.enqueue(t, k, p),
      });
      // If our lease expired and another worker took over, completeJob affects 0
      // rows — we discard our result rather than clobber the new owner's state.
      this.store.completeJob(job.id, token);
    } catch (err) {
      const attempts = job.attempts + 1;
      const poison = attempts >= this.maxAttempts;
      const backoff = this.baseBackoffMs * 2 ** (attempts - 1);
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
