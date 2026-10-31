/**
 * Background retry with back-off that logs once per failure streak (audit O-5).
 *
 * The kind-31611 announce and the R-53 roster address upgrade both fail at most
 * boots ("publish timed out" on every relay, under the startup burst) and are
 * retried in the background. They retried on a fixed 10-minute cadence and
 * logged every failed attempt, so a relay outage of an afternoon was a dozen
 * identical lines per task. Now the gaps grow, the first failure of a streak is
 * logged with when the next try is, the rest are counted silently, and the end of
 * the streak (success, or giving up) is logged with the count.
 */
import { describeError } from "./log-line.js";

export interface BackgroundRetryOptions {
  /** What is being retried, for the log lines ("announce (kind 31611)"). */
  label: string;
  /** One attempt; resolves when the work is done, throws when it is not. */
  attempt: () => Promise<void>;
  /** Gaps between attempts (ms); the last one repeats. */
  delaysMs: readonly number[];
  /** Total attempts, the first included. Unbounded when omitted. */
  maxAttempts?: number;
  log: (msg: string) => void;
  /** Injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
}

export interface BackgroundRetry {
  /** Settles with the FIRST attempt's outcome, so a caller can await just that. */
  first: Promise<boolean>;
  /** Settles when the work is done (true), given up on or stopped (false). */
  settled: Promise<boolean>;
  stop: () => void;
}

const defaultTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return { cancel: () => clearTimeout(t) };
};

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/** Run `attempt` now, then again on the back-off schedule until it succeeds. */
export function retryInBackground(opts: BackgroundRetryOptions): BackgroundRetry {
  const setTimer = opts.setTimer ?? defaultTimer;
  const max = opts.maxAttempts ?? Number.POSITIVE_INFINITY;
  let attempts = 0;
  let stopped = false;
  let timer: { cancel: () => void } | undefined;
  let resolveFirst!: (ok: boolean) => void;
  let resolveSettled!: (ok: boolean) => void;
  const first = new Promise<boolean>((r) => (resolveFirst = r));
  const settled = new Promise<boolean>((r) => (resolveSettled = r));

  const run = async (): Promise<void> => {
    if (stopped) return;
    attempts++;
    try {
      await opts.attempt();
      if (attempts > 1) opts.log(`${opts.label} succeeded on attempt ${attempts} after ${attempts - 1} failure(s)`);
      if (attempts === 1) resolveFirst(true);
      resolveSettled(true);
      return;
    } catch (e) {
      if (attempts === 1) resolveFirst(false);
      if (stopped) return;
      if (attempts >= max) {
        opts.log(`${opts.label} gave up after ${attempts} attempt(s): ${describeError(e)}`);
        resolveSettled(false);
        return;
      }
      const delay = opts.delaysMs[Math.min(attempts - 1, opts.delaysMs.length - 1)] ?? 60_000;
      if (attempts === 1) {
        opts.log(
          `${opts.label} failed: ${describeError(e)} — retrying in the background, next in ${minutes(delay)} ` +
            "(further failures are counted, not logged, until it succeeds or gives up)",
        );
      }
      timer = setTimer(() => void run(), delay);
    }
  };
  void run();
  return {
    first,
    settled,
    stop: () => {
      stopped = true;
      timer?.cancel();
      resolveFirst(false);
      resolveSettled(false);
    },
  };
}
