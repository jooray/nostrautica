/**
 * Job runner (spec §9.2). Each pipeline stage is an idempotent job with a dedupe
 * key = hash of stage inputs, retried with exponential backoff (max attempts,
 * then a poison state surfaced to the organizer). Because every stage is keyed by
 * its input hash and writes results into content-addressed caches, a restart
 * mid-pipeline never re-bills (IMPLEMENTATION_PLAN §3.11).
 */
import type { Store, JobRow } from "../store/db.js";

export type JobHandler = (payload: any, ctx: { enqueue: EnqueueFn }) => Promise<void>;
export type EnqueueFn = (type: string, dedupeKey: string, payload: unknown) => void;

export interface JobRunnerOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  now?: () => number;
}

export class JobRunner {
  private handlers = new Map<string, JobHandler>();
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly now: () => number;

  constructor(private readonly store: Store, opts: JobRunnerOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  enqueue(type: string, dedupeKey: string, payload: unknown): void {
    this.store.enqueueJob(type, dedupeKey, payload);
  }

  /** Run one claimable job. Returns true if a job was processed, false if idle. */
  async runOne(): Promise<boolean> {
    const job = this.store.claimNextJob(this.now());
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  /** Drain the queue until no runnable jobs remain (bounded to avoid loops). */
  async drain(maxIterations = 10_000): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      if (!(await this.runOne())) return;
    }
  }

  private async execute(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.store.failJob(job.id, job.attempts + 1, this.now(), `no handler for ${job.type}`, true);
      return;
    }
    try {
      await handler(JSON.parse(job.payload), {
        enqueue: (t, k, p) => this.enqueue(t, k, p),
      });
      this.store.completeJob(job.id);
    } catch (err) {
      const attempts = job.attempts + 1;
      const poison = attempts >= this.maxAttempts;
      const backoff = this.baseBackoffMs * 2 ** (attempts - 1);
      this.store.failJob(
        job.id,
        attempts,
        this.now() + backoff,
        err instanceof Error ? err.message : String(err),
        poison,
      );
    }
  }
}
