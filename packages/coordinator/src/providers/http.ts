/**
 * Provider HTTP timeout wrapper (audit H-4).
 *
 * Bare `fetch()` has no timeout: a provider that accepts the connection but never
 * finishes headers or body would hang the request forever. Because the coordinator
 * drains events sequentially and a job holds a fixed lease, one stalled provider
 * call blocks all other work and lets the lease expire while the handler is still
 * parked in `await`. Every provider request must therefore run under an explicit
 * total deadline.
 *
 * The deadline covers the WHOLE operation — connect, headers, AND body read — so
 * the caller must do its `res.json()`/`res.text()` INSIDE the callback, while the
 * `AbortController` is still armed. On expiry the fetch (or body read) aborts and
 * we throw a distinctly-worded {@link ProviderTimeoutError} so `errorCategory()`
 * classifies it as `provider_timeout` rather than the catch-all, and so a
 * Cashu-paying caller can treat the reservation as ambiguous via `payment.fail()`.
 */

/** A provider request exceeded its total deadline (connect + headers + body). */
export class ProviderTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`provider timeout: ${label} exceeded ${timeoutMs}ms`);
    this.name = "ProviderTimeoutError";
  }
}

/** Default total deadlines per provider operation class (ms). */
export const PROVIDER_TIMEOUTS = {
  /** Model/info discovery — small, fast metadata reads. */
  metadata: 30_000,
  /** Chat completions — reasoning models can be slow; give real headroom. */
  completion: 120_000,
  /** Embeddings — batched but bounded. */
  embedding: 60_000,
  /** Speech-to-text — larger multipart upload + decode. */
  stt: 180_000,
  /**
   * Payment header preparation, i.e. `PaymentStrategy.prepare()` — see
   * {@link withUncancellableDeadline}. ApiKeyPayment returns synchronously; a
   * CashuPayment talks to a mint (loadMint + send) over the network with no
   * timeout of its own, and it runs BEFORE the request deadline is armed, so
   * without this bound a black-holing mint parks the (serial) job loop forever
   * with no log line at all.
   */
  payment: 30_000,
} as const;

/**
 * Bound a promise that cannot be cancelled — `PaymentStrategy.prepare()` takes no
 * `AbortSignal`, and `@cashu/cashu-ts` owns the socket, so nothing we can pass in
 * would stop the underlying request.
 *
 * The rejection therefore does NOT stop the work; it frees the AWAITER. That is the
 * point: the coordinator drains jobs strictly one at a time, so an unbounded await
 * anywhere in a handler stops the entire pipeline silently — no timeout fires, no
 * job fails, nothing is logged, and only the queue-depth reporter would ever show
 * it. Freeing the awaiter turns "everything stopped forever" into one failed job
 * with a named, categorized error. The abandoned promise's rejection is swallowed
 * so a late failure can't surface as an unhandled rejection.
 */
export async function withUncancellableDeadline<T>(
  label: string,
  timeoutMs: number,
  start: () => Promise<T>,
): Promise<T> {
  const work = start();
  work.catch(() => {}); // the race may abandon it; never let it land as unhandled
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderTimeoutError(label, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── provider HTTP failures (production incident 2026-07-24) ───────────────────
// A non-2xx from a provider used to become a bare Error whose only chance of being
// seen was some caller happening to log it. It reached the job runner's retry line
// truncated to 160 chars — and never reached a log at all when a caller swallowed
// it. Credit exhaustion (Venice DIEM) is the case that matters most in practice:
// the operator needs "top up the account", not "score_batch failed". So the
// classification AND the log happen HERE, at the boundary, before the error is
// thrown — a caller's catch can no longer make the failure invisible.

/** Response body kept in a log line / error message (bytes). */
const BODY_EXCERPT_MAX = 300;

/** A provider returned a non-2xx response. Carries the status + a body excerpt. */
export class ProviderHttpError extends Error {
  constructor(
    readonly label: string,
    readonly status: number,
    readonly bodyExcerpt: string,
    /** Credit/quota exhaustion rather than any other failure — see {@link isPaymentFailure}. */
    readonly payment: boolean,
    message: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

/**
 * Is this response credit/quota exhaustion (as opposed to auth, rate limiting, a
 * bad request, or a provider outage)? A plain 429 is deliberately NOT payment —
 * ordinary rate limiting is transient and retrying fixes it — unless the body
 * itself names a balance/credit/quota problem, which is how several
 * OpenAI-compatible gateways report a depleted account.
 */
export function isPaymentFailure(status: number, body: string): boolean {
  if (status === 402) return true;
  return /insufficient[_ ]?(balance|credit|funds)|out[_ ]of[_ ](credit|diem|balance)|quota[_ ]?exceeded|billing|payment[_ ]required/i.test(
    body,
  );
}

/** Timestamp prefix matching the coordinator's own `log()` format. */
function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

/**
 * Build (and LOG) the error for a non-2xx provider response. Reads the body inside
 * the caller's still-armed deadline, so this must be called from inside the
 * `guardedProviderFetch` callback.
 *
 * The payment message keeps the words "billing" and "insufficient balance"
 * verbatim: `errorCategory()` in coordinator.ts matches on them to classify the
 * job failure as `provider_billing`, which is what gives it the long retry tail
 * (an operator top-up hours later resolves it) instead of poisoning in seconds.
 */
export async function providerHttpError(
  res: Response,
  label: string,
  tag: "llm" | "stt" = "llm",
): Promise<ProviderHttpError> {
  const raw = await res.text().catch(() => "");
  const body = raw.replace(/\s+/g, " ").trim().slice(0, BODY_EXCERPT_MAX) || "(empty body)";
  const payment = isPaymentFailure(res.status, raw);
  if (payment) {
    // Loud and specific: this one is fixed by topping up an account, not by
    // debugging the coordinator, and nothing else in the pipeline can tell the
    // operator that.
    console.error(
      `[${stamp()}] [${tag}] payment/credit failure (${res.status}) — ${label}: ${body} — provider account is out of credit; paid work keeps failing until it is topped up`,
    );
    return new ProviderHttpError(
      label,
      res.status,
      body,
      true,
      `provider billing: insufficient balance (${res.status}) — ${label}: ${body}`,
    );
  }
  console.warn(`[${stamp()}] [${tag}] provider error (${res.status}) — ${label}: ${body}`);
  return new ProviderHttpError(label, res.status, body, false, `${label} failed: ${res.status} ${body}`);
}

/**
 * Run `fn` under a total wall-clock deadline, passing it an `AbortSignal` the
 * caller MUST forward to `fetch()` (and which aborts any in-progress body read).
 * If the deadline fires the underlying operation is aborted and a
 * {@link ProviderTimeoutError} is thrown; any other error propagates unchanged.
 *
 * A `callerSignal` (audit R13: shutdown / per-event cancellation) is COMBINED with
 * the per-operation deadline via `AbortSignal.any()`, so a coordinator shutdown or a
 * retention/detach teardown unwinds a blocked provider call promptly instead of
 * waiting out the (up to 3-minute STT) deadline or the cgroup stop timeout. A
 * caller-signal abort propagates as its own reason (NOT reclassified as a timeout);
 * only the internal deadline firing yields a {@link ProviderTimeoutError}.
 */
export async function withProviderTimeout<T>(
  label: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  // Fail fast if the caller was already cancelled before we opened a socket.
  callerSignal?.throwIfAborted();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, ac.signal]) : ac.signal;
  try {
    return await fn(signal);
  } catch (e) {
    // The internal deadline is what makes fetch()/body-read reject on TIMEOUT;
    // distinguish it from a caller-signal cancellation (which must surface as the
    // caller's own abort reason so the runner treats it as a teardown, not a
    // retryable provider failure) and from an unrelated same-window error.
    if (ac.signal.aborted && !callerSignal?.aborted) throw new ProviderTimeoutError(label, timeoutMs);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
