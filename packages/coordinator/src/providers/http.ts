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
} as const;

/**
 * Run `fn` under a total wall-clock deadline, passing it an `AbortSignal` the
 * caller MUST forward to `fetch()` (and which aborts any in-progress body read).
 * If the deadline fires the underlying operation is aborted and a
 * {@link ProviderTimeoutError} is thrown; any other error propagates unchanged.
 */
export async function withProviderTimeout<T>(
  label: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fn(ac.signal);
  } catch (e) {
    // The abort is what makes fetch()/body-read reject; distinguish "we timed
    // out" from an unrelated failure that happened to occur in the same window.
    if (ac.signal.aborted) throw new ProviderTimeoutError(label, timeoutMs);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
