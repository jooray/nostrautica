/**
 * Job runner (spec §9.2). Each pipeline stage is an idempotent job with a dedupe
 * key = hash of stage inputs, retried with exponential backoff (max attempts,
 * then a poison state surfaced to the organizer). Because every stage is keyed by
 * its input hash and writes results into content-addressed caches, a restart
 * mid-pipeline never re-bills (IMPLEMENTATION_PLAN §3.11).
 */
import { randomUUID } from "node:crypto";
import type { Store, JobRow, EnqueueOutcome } from "../store/db.js";

export type JobHandler = (payload: any, ctx: { enqueue: EnqueueFn; signal: AbortSignal }) => Promise<void>;
/** Returns what the enqueue did, so a caller can summarize a dispatch (see
 *  {@link JobRunner.enqueue}); most callers ignore it. */
export type EnqueueFn = (
  type: string,
  dedupeKey: string,
  payload: unknown,
  /** Epoch ms before which the job must not run (default: runnable immediately). */
  notBefore?: number,
) => EnqueueOutcome;

/** How long a pooled worker waits for a sibling to free the lane it needs. */
const IDLE_POLL_MS = 50;

/**
 * What ONE drain call currently has in flight: workers claiming or running a job
 * (`busy`), and how many of those are in each lane.
 *
 * Per drain, not per process, and not read off {@link JobRunner.inFlight}: a job
 * claimed by a caller outside this drain — a lease another process took over, or a
 * test holding one paused to prove a stale commit is discarded — is not this
 * pool's to account for, and counting it would let one external job block the
 * drain from claiming any serial work at all.
 */
interface PoolState {
  busy: number;
  score: number;
  serial: number;
}

/** Which lane a job type runs in (see {@link SCORE_LANE}). */
function laneOf(type: string): "score" | "serial" {
  return (SCORE_LANE as readonly string[]).includes(type) ? "score" : "serial";
}

/** `[hh:mm:ss] ` prefix, matching coordinator.ts's `log()`. */
function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

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

/** A poisoned job, surfaced so the coordinator can notify the organizer (Q12).
 *  `parked` marks the {@link JobRunnerOptions.poisonExempt} variant: the job was
 *  NOT discarded, but it has stopped and needs someone to act. */
export interface PoisonInfo {
  type: string;
  payload: any;
  attempts: number;
  error: string;
  parked?: { reason: string };
}

/**
 * Job types that may run beside one another. Everything NOT listed shares one
 * implicit `serial` lane with a limit of 1, which is the whole daemon's
 * behaviour up to now — so adding a lane can only ever relax a constraint that
 * was there, never silently widen one that was not.
 *
 * Only the two LLM scoring types are listed, and deliberately. They are the long
 * jobs — 50 to 134 seconds each in production, against tens of milliseconds for a
 * publish — and they are the ones that touch nothing shared: one provider call
 * through a reentrant client, writes to directed pair rows that are idempotent and
 * re-checked after the call, and an enqueue through a synchronous store. No MLS
 * group state, no roster, no ECK, no command watermarks, no media download, no
 * byte budget. Every other type keeps the guarantee it has today: at most one of
 * anything else runs at a time, and it never overlaps another job that could be
 * reading the same rows.
 */
export const SCORE_LANE = ["score_batch", "score_reverse_batch"] as const;

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
  /**
   * How many {@link SCORE_LANE} jobs may run at once (default 1 — strictly serial,
   * the historical behaviour every other test relies on). The daemon raises it;
   * see `main.ts` for the one configuration that must NOT.
   */
  scoreConcurrency?: number;
  now?: () => number;
  /** Called when a job exhausts its retries and enters the poison state (Q12). */
  onPoison?: (info: PoisonInfo) => void;
  /**
   * Consulted only when a job is about to poison: return a reason to PARK it
   * instead, or undefined to let it poison normally.
   *
   * For failures that are about the world rather than the work — a provider
   * account out of credit is the case this exists for — the retry tail running
   * out means "this outage lasted longer than three days", not "this job is
   * bad". Poisoning discards it, and the attendee's profile is simply never
   * built. Parked, it survives until an organizer reprocess/recompute revives
   * it. The runner does not itself know a billing error from any other, so the
   * classification is injected by the coordinator.
   */
  poisonExempt?: (err: unknown) => string | undefined;
  /**
   * Consulted on every failure: return a SHORTER attempt cap for this error, or
   * undefined for the default tail.
   *
   * The default schedule spends ~26 attempts over three days, which is right for a
   * failure that might clear on its own — a relay outage, a provider hiccup. It is
   * exactly wrong for a DETERMINISTIC failure, where the same prompt and the same
   * model will produce the same malformed shape every time: those spent three fully
   * billed days re-asking a question already answered, and only then poisoned.
   *
   * Prod evidence (2026-09-04): two attendees sat poisoned since mid-July on
   * `process_attendee` with error_category=provider_contract, and a third cleared
   * only after 27 attempts. The classification already existed — it was computed
   * for the organizer's status notice and then thrown away.
   *
   * Injected rather than inferred here: the runner deliberately knows nothing about
   * providers, same as {@link poisonExempt}.
   */
  retryBudget?: (err: unknown) => number | undefined;
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
  private readonly scoreConcurrency: number;
  private readonly now: () => number;
  private readonly onPoison?: (info: PoisonInfo) => void;
  private readonly poisonExempt?: (err: unknown) => string | undefined;
  private readonly retryBudget?: (err: unknown) => number | undefined;

  constructor(private readonly store: Store, opts: JobRunnerOptions = {}) {
    this.backoffSchedule =
      opts.backoffScheduleMs ??
      (opts.maxAttempts !== undefined || opts.baseBackoffMs !== undefined
        ? Array.from({ length: (opts.maxAttempts ?? 5) - 1 }, (_, i) => (opts.baseBackoffMs ?? 1000) * 2 ** i)
        : DEFAULT_BACKOFF_SCHEDULE_MS);
    this.maxAttempts = opts.maxAttempts ?? this.backoffSchedule.length + 1;
    this.leaseMs = opts.leaseMs ?? 5 * 60_000;
    this.scoreConcurrency = Math.max(1, opts.scoreConcurrency ?? 1);
    this.now = opts.now ?? (() => Date.now());
    this.onPoison = opts.onPoison;
    this.poisonExempt = opts.poisonExempt;
    this.retryBudget = opts.retryBudget;
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

  /**
   * Enqueue, and make a DISCARDED enqueue visible. Coalescing onto a row that is
   * still `pending`/`running`/`waiting` is the intended behavior and stays quiet;
   * colliding with a `done`/`poison` row is not — that row is terminal, nothing
   * will re-run it, and the requested work simply never happens. Until this line
   * existed the only symptom was a dispatch log followed by silence forever
   * (production incident 2026-07-24).
   */
  enqueue(type: string, dedupeKey: string, payload: unknown, notBefore = 0): EnqueueOutcome {
    const outcome = this.store.enqueueJob(type, dedupeKey, payload, notBefore);
    if (outcome === "done" || outcome === "poison") {
      console.warn(
        `[${stamp()}] [job] ${type} enqueue DISCARDED — dedupe key already '${outcome}': ${dedupeKey.slice(0, 120)} — this work will NOT run`,
      );
    }
    return outcome;
  }

  /** Reclaim leases stranded by a crash (audit H1). Call at startup + periodically. */
  recoverStrandedJobs(): number {
    return this.store.reclaimExpiredLeases(this.now());
  }

  /** Set once shutdown begins: `drain` stops claiming NEW jobs (the in-flight job
   *  still finishes) so a graceful stop can await active work and then close. */
  private stopping = false;

  /**
   * Cancellation token for in-flight handlers (audit C11). Its signal is passed to
   * every handler (and, in turn, to provider/media calls), so after the graceful
   * drain window expires, {@link abort} can tell a blocked handler to unwind — the
   * shutdown then AWAITS the drain promise so resources are never closed under a
   * handler still writing/publishing against them.
   */
  private abortController = new AbortController();

  /** Stop claiming new jobs (reliability tail: graceful shutdown drain). The job
   *  currently executing inside `runOne` is awaited by the caller; no new job is
   *  claimed after this. Idempotent. */
  stopClaiming(): void {
    this.stopping = true;
  }

  /** The cancellation signal handed to handlers (audit C11). */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Abort the in-flight handler (audit C11): fired after the graceful-drain window
   * expires so a blocked provider/media call unwinds. The caller MUST then await the
   * outstanding drain promise before closing transport/store/lock. Idempotent.
   *
   * Also stops claiming, which `main.ts` already did on its own line before calling
   * this. It has to be here rather than only at the call site: once the signal is
   * aborted, every job the drain loop goes on to claim is handed an already-aborted
   * signal, so the loop would spin through the whole queue handing out cancellations
   * — and now that an aborted job is RELEASED back to `pending` (runnable at once)
   * instead of left `running` under an unexpired lease, that spin is on the same row
   * forever, up to `maxIterations`. Aborting and continuing to claim is not a
   * combination anything wants.
   */
  abort(reason = "coordinator shutting down"): void {
    this.stopping = true;
    if (!this.abortController.signal.aborted) this.abortController.abort(new Error(reason));
  }

  /**
   * Which types this worker may claim right now, given what its siblings are
   * already running. The serial lane (everything not in {@link SCORE_LANE}) holds
   * one job at a time, so once one is in flight a second worker may only take
   * score work — and once the score lane is full, only serial work.
   */
  private claimableTypes(pool: PoolState): { onlyTypes?: string[]; excludeTypes?: string[] } {
    const scoreFull = pool.score >= this.scoreConcurrency;
    const serialFull = pool.serial >= 1;
    if (serialFull && scoreFull) return { onlyTypes: [] }; // nothing claimable
    if (serialFull) return { onlyTypes: [...SCORE_LANE] };
    if (scoreFull) return { excludeTypes: [...SCORE_LANE] };
    return {};
  }

  /**
   * Run one claimable job under a fresh lease. Returns true if a job was processed.
   *
   * `pool` is the drain's own accounting; without it the claim is unrestricted,
   * which is what a direct caller (a test driving one job at a time) expects.
   */
  async runOne(pool?: PoolState): Promise<boolean> {
    const token = randomUUID();
    const job = this.store.claimNextJob(
      this.now(),
      token,
      this.leaseMs,
      pool ? this.claimableTypes(pool) : undefined,
    );
    if (!job) return false;
    const lane = laneOf(job.type);
    if (pool) pool[lane]++;
    try {
      await this.execute(job, token);
    } finally {
      if (pool) pool[lane]--;
    }
    return true;
  }

  /**
   * Drain the queue until no runnable jobs remain (bounded to avoid loops). Stops
   * claiming new jobs once {@link stopClaiming} has been called (graceful shutdown).
   *
   * With `scoreConcurrency > 1` this runs a small pool. Every worker promise is
   * awaited here and the first rejection is rethrown, because an un-awaited one
   * would reach `unhandledRejection` — which this daemon turns into `exit(1)`
   * (lifecycle.ts) — and would take the process down with the other workers still
   * writing. The caller (`main.ts`) keeps ONE drain promise that now covers all of
   * them, so the graceful-shutdown window still waits for every live handler
   * before the store and the daemon lock are closed.
   */
  async drain(maxIterations = 10_000): Promise<void> {
    const pool: PoolState = { busy: 0, score: 0, serial: 0 };
    if (this.scoreConcurrency <= 1) return this.workerLoop(maxIterations, pool);
    const workers = Array.from({ length: this.scoreConcurrency }, () => this.workerLoop(maxIterations, pool));
    const settled = await Promise.allSettled(workers);
    const failed = settled.find((r) => r.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }

  private async workerLoop(maxIterations: number, pool: PoolState): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      if (this.stopping) return;
      pool.busy++;
      let ran: boolean;
      try {
        ran = await this.runOne(pool);
      } finally {
        pool.busy--;
      }
      if (ran) continue;
      // Nothing claimable BY THIS WORKER. That is not the same as an empty queue: a
      // SIBLING may be holding the lane whose turn it is, and a worker that returned
      // here would leave the pool at one until the next drain — for the whole length
      // of a sibling's 130-second scoring call. So wait for a sibling, and finish
      // only once no sibling is running either.
      //
      // Counted per drain, deliberately, and not off `inFlight`: a job claimed by a
      // caller OUTSIDE this drain (tests hold one paused mid-STT to prove a stale
      // commit is discarded) is not this pool's to wait for, and waiting on it
      // deadlocks a drain that is otherwise finished.
      if (pool.busy === 0) return;
      await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
    }
  }

  /**
   * The jobs executing right now, keyed by job id. Read by {@link reportQueueDepth}
   * so a stalled handler is visible as "running for 340s" rather than as an absence
   * of output — and, since the pool, so that a second live job is visible at all
   * instead of one silently overwriting the other's entry.
   */
  private inFlight = new Map<number, { id: number; type: string; startedAt: number }>();

  /**
   * One line describing the queue, emitted only when there is something to say.
   * Called on a timer (see {@link startQueueReporter}) rather than from the drain
   * loop on purpose: a handler that never returns blocks the loop, and the whole
   * point is to still see the queue in exactly that case.
   *
   * Idle-and-empty prints nothing — but a `running` entry with a growing age, or a
   * non-zero pending/waiting count that never moves, distinguishes "the work is
   * stuck" from "the work was never queued", which is the distinction the
   * 2026-07-24 incident had no way to make.
   */
  reportQueueDepth(): void {
    const counts = this.store.jobStateCounts();
    const pending = counts.pending ?? 0;
    const waiting = counts.waiting ?? 0;
    const running = counts.running ?? 0;
    const poison = counts.poison ?? 0;
    if (pending === 0 && waiting === 0 && running === 0 && poison === 0 && this.inFlight.size === 0) return;
    const active =
      [...this.inFlight.values()]
        .map((j) => `${j.type} #${j.id} for ${Math.round((this.now() - j.startedAt) / 1000)}s`)
        .join(", ") || "idle";
    const label = this.inFlight.size > 1 ? "workers" : "worker";
    console.log(
      `[${stamp()}] [jobs] queue: ${pending} pending, ${running} running, ${waiting} waiting (parked), ${poison} poisoned — ${label}: ${active}`,
    );
  }

  /** Start the periodic queue report (unref'd). Returns a stop function. */
  startQueueReporter(intervalMs = 60_000): () => void {
    const timer = setInterval(() => this.reportQueueDepth(), intervalMs);
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  }

  private async execute(job: JobRow, token: string): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      // Poisoned WITHOUT a word until now — a job type that lost its registration
      // (a rename, a half-applied deploy) vanished into the poison state silently.
      console.warn(`[${stamp()}] [job] ${job.type} #${job.id} POISONED: no handler registered`);
      this.store.failJob(job.id, job.attempts + 1, this.now(), `no handler for ${job.type}`, true, token);
      return;
    }
    const startedAt = this.now();
    this.inFlight.set(job.id, { id: job.id, type: job.type, startedAt });
    console.log(`[${stamp()}] [job] ${job.type} #${job.id} started (attempt ${job.attempts + 1})`);
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
        signal: this.abortController.signal,
      });
      // If our lease expired and another worker took over, completeJob affects 0
      // rows — we discard our result rather than clobber the new owner's state.
      const owned = this.store.completeJob(job.id, token);
      const ms = this.now() - startedAt;
      if (owned) {
        console.log(`[${stamp()}] [job] ${job.type} #${job.id} done in ${ms}ms`);
      } else {
        // Silently dropping a finished result is exactly the kind of thing that
        // looks like "the pipeline just stopped" from the outside.
        console.warn(
          `[${stamp()}] [job] ${job.type} #${job.id} finished in ${ms}ms but its lease was LOST — result discarded (another worker owns it)`,
        );
      }
    } catch (err) {
      const ms = this.now() - startedAt;
      // A shutdown abort (audit C11) is not a real failure: hand the row straight
      // back to the queue, runnable NOW and with its retry counter untouched.
      //
      // This used to just `return`, leaving the row `running` and calling that
      // "claimable for restart". It was not: `claimNextJob`'s stranded-job arm and
      // `reclaimExpiredLeases` BOTH require `lease_until <= now`, and the heartbeat
      // had pushed that lease to `now + leaseMs` less than a third of a lease ago.
      // A deploy landing mid-job therefore idled that attendee's pipeline for up to
      // the full five-minute lease past the restart, while the fresh daemon logged
      // "recovered 0 stranded job(s)" — the gap had no explanation anywhere.
      // `releaseJob` preserves the documented "consumes no retry" contract (unlike
      // failJob) and does not park it out of reach (unlike parkJob).
      if (this.abortController.signal.aborted) {
        const released = this.store.releaseJob(job.id, token);
        console.log(
          `[${stamp()}] [job] ${job.type} #${job.id} aborted for shutdown after ${ms}ms — ` +
            (released
              ? "released back to the queue, runnable immediately on restart (no retry consumed)"
              : "lease already lost — another worker owns the row"),
        );
        return;
      }
      // A billing/budget PARK is not a failure: move to `waiting` (coalesced, no
      // retry consumed, never poisons) — resumed when the block clears (H-2).
      if (err instanceof ParkJobError) {
        const parked = this.store.parkJob(job.id, err.message, token);
        // Logged even when the park did NOT stick (lease lost): "we decided to park
        // and someone else owns the row" is still an outcome the log must carry.
        console.log(
          `[${stamp()}] [job] ${job.type} #${job.id} PARKED (waiting) after ${ms}ms${parked ? "" : " [lease lost — not applied]"}: ${err.message.slice(0, 160)}`,
        );
        return;
      }
      const attempts = job.attempts + 1;
      // A deterministic failure gets a short cap; everything else keeps the long
      // tail. Never longer than the default — this may only tighten.
      const budget = Math.min(this.retryBudget?.(err) ?? this.maxAttempts, this.maxAttempts);
      const poison = attempts >= budget;
      const backoff = this.backoffForAttempt(attempts);
      const msg = err instanceof Error ? err.message : String(err);
      // Out of retries, but the failure says the provider account is empty rather
      // than that the job is bad. Park instead of poisoning: the work is still
      // valid and an organizer reprocess (or a billing unblock) can run it, where
      // poisoning would silently cost an attendee their profile for a problem
      // that a top-up fixes. Attempts reset so the revived job gets a fresh tail
      // rather than one doomed call.
      if (poison) {
        const parkReason = this.poisonExempt?.(err);
        if (parkReason) {
          const parked = this.store.parkJob(job.id, `${parkReason}: ${msg}`, token, { resetAttempts: true });
          console.warn(
            `[${stamp()}] [job] ${job.type} #${job.id} PARKED instead of poisoned after ${attempts} attempt(s)${parked ? "" : " [lease lost — not applied]"}: ${parkReason} — ${msg.slice(0, 200)}`,
          );
          // Tell somebody. This park is reached only after the retry tail ran out
          // — three days — so it means "this outage outlasted every retry", and
          // the work now sits waiting for a human (a provider top-up, an organizer
          // reprocess). It used to return here without calling `onPoison`, so no
          // 21606 went out at all: the organizer's Admin view showed nothing wrong
          // and the attendee's screen said "processing" indefinitely. Same
          // notification as a poison, with the reason attached — it is the same
          // fact to the reader ("this stopped and needs you"), and it stays inside
          // the frozen 21606 schema.
          if (parked && this.onPoison) {
            this.onPoison({
              type: job.type,
              payload: safeParse(job.payload),
              attempts,
              error: msg,
              parked: { reason: parkReason },
            });
          }
          return;
        }
      }
      console.warn(
        `[${stamp()}] [job] ${job.type} #${job.id} ${poison ? `POISONED after ${attempts}/${budget}` : `failed (retry ${attempts}/${budget}, next in ${backoff}ms)`} after ${ms}ms: ${msg.slice(0, 300)}`,
      );
      const owned = this.store.failJob(job.id, attempts, this.now() + backoff, msg, poison, token);
      // Only surface the poison if we still owned the lease (a stale worker whose
      // lease was stolen must not fire a duplicate organizer notification).
      if (poison && owned && this.onPoison) {
        this.onPoison({ type: job.type, payload: safeParse(job.payload), attempts, error: msg });
      }
    } finally {
      clearInterval(heartbeat);
      this.inFlight.delete(job.id);
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
