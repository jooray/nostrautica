/**
 * Count of billed provider requests actually sent (audit KIMIK31 R-6). Logged,
 * never enforced.
 *
 * The `*_calls` budgets charge one unit per paid JOB RUN (`assertSpendAllowed`),
 * and the owner's decision is to keep it that way. But one run can make several
 * billed requests: an uncached attendee is an STT request per media item, a
 * Nostr-context summary, the profile and a translation, and a match batch adds a
 * decision request when `match_score` is set. A budget figure alone therefore
 * understates the bill by a factor the operator could not see. This meter makes
 * that factor visible: each job's outcome line says how many requests it sent,
 * and a periodic `[budget]` line sets the window's request total beside the
 * counted runs.
 *
 * The hook is {@link withProviderTimeout} (providers/http.ts). Every provider
 * HTTP request runs under it, so classifying its label there counts every billed
 * request without touching the call sites, including the second request of an
 * adapter-internal retry (VeniceLlm's learn-and-retry) and requests that then
 * fail or come back 402. Metadata requests (`GET /models`, `GET /info`) are free
 * and are not counted.
 *
 * In memory only: hourly buckets for the daemon-wide window, plus a per-job tally
 * carried through the job's async context. A restart starts the count over,
 * which the summary line states.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type ProviderRequestKind = "chat" | "decision" | "embed" | "stt";

/** Display order in a log line. */
const KINDS: readonly ProviderRequestKind[] = ["stt", "chat", "decision", "embed"];

export interface RequestTally {
  /** Billed provider requests sent. */
  total: number;
  byKind: Partial<Record<ProviderRequestKind, number>>;
  /** Runs charged against the `*_calls` budgets (per-job tally only). */
  runs: number;
}

export function emptyTally(): RequestTally {
  return { total: 0, byKind: {}, runs: 0 };
}

function add(t: RequestTally, kind: ProviderRequestKind, n = 1): void {
  t.total += n;
  t.byKind[kind] = (t.byKind[kind] ?? 0) + n;
}

/**
 * Which billed request a {@link withProviderTimeout} label names, or `undefined`
 * for a free metadata request. Labels are the adapters' own (`Venice STT`,
 * `Routstr chat/completions`, …); request-meter.test.ts drives every adapter
 * method through it, so renaming a label without updating this fails a test
 * rather than silently dropping a kind from the count.
 */
export function billedKindOf(label: string): ProviderRequestKind | undefined {
  if (/\bGET\b/.test(label)) return undefined;
  if (/chat\/completions$/.test(label)) return "chat";
  if (/ decisions$/.test(label)) return "decision";
  if (/ embeddings$/.test(label)) return "embed";
  if (/ STT$/.test(label)) return "stt";
  return undefined;
}

/** `5 provider requests (stt 2, chat 3)`; `0 provider requests` when empty. */
export function formatTally(t: RequestTally): string {
  const noun = t.total === 1 ? "provider request" : "provider requests";
  const parts = KINDS.filter((k) => (t.byKind[k] ?? 0) > 0).map((k) => `${k} ${t.byKind[k]}`);
  return parts.length ? `${t.total} ${noun} (${parts.join(", ")})` : `${t.total} ${noun}`;
}

/**
 * What a finished job spent, for its outcome line: `1 counted run, 5 provider
 * requests (stt 2, chat 3)`. `undefined` when it neither counted a run nor sent a
 * request, so the many free jobs (publishes, roster work) keep their short line.
 */
export function formatJobSpend(t: RequestTally): string | undefined {
  if (t.runs === 0 && t.total === 0) return undefined;
  return `${t.runs} counted run${t.runs === 1 ? "" : "s"}, ${formatTally(t)}`;
}

const HOUR_MS = 3_600_000;
/** Longest window kept; matches the `daemon_window_hours` maximum. */
const MAX_WINDOW_HOURS = 24 * 7;

/** Daemon-wide counter in hourly buckets, aligned like `daemon_usage`'s. */
export class ProviderRequestMeter {
  private readonly buckets = new Map<number, RequestTally>();
  readonly startedAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  record(kind: ProviderRequestKind): void {
    const hour = Math.floor(this.now() / HOUR_MS);
    let b = this.buckets.get(hour);
    if (!b) {
      b = emptyTally();
      this.buckets.set(hour, b);
      for (const h of this.buckets.keys()) if (h <= hour - MAX_WINDOW_HOURS) this.buckets.delete(h);
    }
    add(b, kind);
  }

  /** Requests in the last `windowHours`, bucket-aligned like `Store.getDaemonUsage`. */
  window(windowHours: number): RequestTally {
    const from = Math.floor(this.now() / HOUR_MS) - windowHours + 1;
    const out = emptyTally();
    for (const [hour, b] of this.buckets) {
      if (hour < from) continue;
      for (const k of KINDS) if (b.byKind[k]) add(out, k, b.byKind[k]);
    }
    return out;
  }
}

/** The process-wide meter {@link recordProviderRequest} feeds. */
export const providerRequests = new ProviderRequestMeter();

const jobScope = new AsyncLocalStorage<RequestTally>();

/**
 * Run `fn` with `tally` as the current job's request tally. Every request sent
 * from inside it, however deep, lands in `tally` as well as the daemon-wide
 * meter. The caller keeps the object, so it is readable on every outcome path,
 * including a throw.
 */
export function runWithRequestTally<T>(tally: RequestTally, fn: () => Promise<T>): Promise<T> {
  return jobScope.run(tally, fn);
}

/** Count one billed request that is about to go out. */
export function recordProviderRequest(kind: ProviderRequestKind, meter: ProviderRequestMeter = providerRequests): void {
  meter.record(kind);
  const t = jobScope.getStore();
  if (t) add(t, kind);
}

/**
 * Note that the current job was charged one run against the `*_calls` budgets
 * (`assertSpendAllowed`), so its outcome line can set runs beside requests. A
 * no-op outside a job.
 */
export function noteCountedRun(): void {
  const t = jobScope.getStore();
  if (t) t.runs += 1;
}

/**
 * The periodic `[budget]` line: the window's counted runs beside the requests
 * they actually sent, e.g.
 * `[budget] last 24h: 40 counted runs (daemon_calls_per_window 80000), 112
 * provider requests (stt 20, chat 80, embed 12), 2.8 per run — requests are
 * logged, not enforced`. `runs` is undefined when no budgets are configured.
 * When the process is younger than the window the request side covers only the
 * uptime (runs are persisted, requests are not), and the line says so.
 */
export function formatWindowSummary(args: {
  windowHours: number;
  runs?: number;
  runLimit?: number;
  requests: RequestTally;
  uptimeMs: number;
}): string {
  const { windowHours, runs, runLimit, requests, uptimeMs } = args;
  let line = `[budget] last ${windowHours}h:`;
  if (runs !== undefined) {
    const limit = runLimit && runLimit > 0 ? String(runLimit) : "unlimited";
    line += ` ${runs} counted run${runs === 1 ? "" : "s"} (daemon_calls_per_window ${limit}),`;
  }
  line += ` ${formatTally(requests)}`;
  if (uptimeMs < windowHours * HOUR_MS) {
    line += ` since this process started ${Math.max(1, Math.round(uptimeMs / 60_000))} min ago`;
  }
  if (runs !== undefined && runs > 0) line += `, ${(requests.total / runs).toFixed(1)} per run`;
  return `${line} — requests are logged, not enforced`;
}
