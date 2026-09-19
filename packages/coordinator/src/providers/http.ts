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
  /**
   * Chat completions — the FLOOR, not the whole story; see
   * {@link completionTimeoutMs}. A flat 120s was below the p95 of the calls this
   * daemon actually makes and production was losing batches to it.
   */
  completion: 120_000,
  /** Embeddings — batched but bounded. */
  embedding: 60_000,
  /**
   * Decision models (`POST /decisions`). Deliberately far below
   * {@link PROVIDER_TIMEOUTS.completion}: a decision call returns in well under a
   * second because nothing is generated — measured p50 0.7–1.2 s for a request
   * carrying 38 candidates and 76 questions, p95 2.2 s uncontended. 60 s is ~25×
   * the slowest honest call and still leaves room for the provider's own 429
   * backoff, so a hung connection unwinds in a minute rather than parking a
   * serial job slot for two.
   */
  decision: 60_000,
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
 * How long a completion may take, given how much output it was ALLOWED to
 * generate. A deadline that ignores `max_tokens` is really two different limits
 * wearing one number: generous for a 500-token summary, and too tight for the
 * 12,000-token budget `batchMaxTokens(10)` hands the match scorer.
 *
 * The flat 120s was the latter. Measured on the production shape (reverse batch,
 * K=10, both languages, 96 calls per model) the DEPLOYED model's p95 is 130.6s
 * and its p50 is 92s — so the ceiling sat below the 95th percentile of ordinary
 * work, and the coordinator log shows exactly that: `score_batch` and
 * `score_reverse_batch` failing at 120,03Xms and retrying. The retry is not free
 * either — the timed-out call still generated its tokens and is still billed, so
 * every one of these costs 120s of the serial job loop AND pays twice.
 *
 * Scaling with the token budget keeps the guard meaningful where it matters: a
 * small call still has to answer promptly, and only a call we deliberately
 * asked for a lot of output gets the longer rope. 25ms per allowed token is
 * roughly 2x the observed p95 for the worst shape, which is headroom for a bad
 * day rather than an invitation to hang.
 */
export function completionTimeoutMs(maxTokens?: number): number {
  return Math.max(PROVIDER_TIMEOUTS.completion, (maxTokens ?? 0) * 25);
}

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
    /** The provider's own `Retry-After`, in seconds, when it sent one. */
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

/**
 * `Retry-After`, in seconds, from a rate-limited/unavailable response. Accepts
 * both wire forms (delta-seconds and an HTTP-date) and clamps to something a job
 * scheduler can act on — a provider asking us to wait a week is telling us
 * something, but not something worth encoding as a literal delay.
 */
export function parseRetryAfter(res: Response, nowMs = Date.now()): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  const value = Number.isFinite(seconds) ? seconds : (Date.parse(raw) - nowMs) / 1000;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.ceil(value), 3600);
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
  // Capped, because this body is attacker-influenced too: only a 300-char excerpt
  // is ever used, so reading an unbounded error body would be a free OOM on the
  // failure path — the one path a hostile provider fully controls the timing of.
  const raw = await readBodyCapped(res, PROVIDER_BODY_LIMITS.error, label).catch(() => "");
  const body = raw.replace(/\s+/g, " ").trim().slice(0, BODY_EXCERPT_MAX) || "(empty body)";
  const payment = isPaymentFailure(res.status, raw);
  const retryAfterSec = parseRetryAfter(res);
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
      retryAfterSec,
    );
  }
  console.warn(`[${stamp()}] [${tag}] provider error (${res.status}) — ${label}: ${body}`);
  return new ProviderHttpError(
    label,
    res.status,
    body,
    false,
    `${label} failed: ${res.status} ${body}`,
    retryAfterSec,
  );
}

// ── response-size caps (2026-09-04 audit) ─────────────────────────────────────
// `guardedProviderFetch` hands the raw `Response` to a handler and caps NOTHING,
// unlike `safeFetch`, which streams every download under an explicit `maxBytes`.
// Every provider handler used to finish with `res.json()`, which buffers whatever
// the socket keeps sending. A provider that is hostile, compromised, or merely
// broken can therefore hold the connection open inside the 120s completion
// deadline and stream gigabytes into the heap of a SINGLE-THREADED daemon that
// drains jobs serially: every event stops, and the OOM kill takes the in-flight
// lease with it without writing a line anyone can read afterwards.
//
// This is not a hypothetical remote. A Routstr node is discovered from an
// UNTRUSTED kind-38421 provider announcement, so the operator never chose the
// host the bytes arrive from — the same threat model `safeFetch` was written for.
//
// The cap lives here rather than in `safe-fetch.ts` because `guardedProviderFetch`
// deliberately hands the body to the caller (the deadline has to cover the body
// read, so the read must happen inside the handler); the handler is the only place
// that knows which response class it is reading.

/** A provider response body exceeded the cap for its operation class. */
export class ProviderResponseTooLargeError extends Error {
  constructor(
    readonly label: string,
    readonly maxBytes: number,
  ) {
    super(`${label}: response body exceeded the ${maxBytes}-byte cap`);
    this.name = "ProviderResponseTooLargeError";
  }
}

/**
 * Byte caps per response class — sized from what a LEGITIMATE answer can be, with
 * an order of magnitude of headroom, because the cost of a cap that is too tight
 * is a failed job and the cost of no cap at all is the whole daemon.
 */
export const PROVIDER_BODY_LIMITS = {
  /** Model catalogues, /info, chat completions, STT transcripts. A K=10 scoring
   *  response is a few tens of KB; a 25 MB audio file's transcript, well under 1 MB. */
  json: 16 * 1024 * 1024,
  /** Embeddings, which are legitimately the largest thing we read: one 1024-dim
   *  bge-m3 vector renders to ~20 KB of JSON text, and a full roster is embedded
   *  in ONE batched call (190 attendees ≈ 4 MB). */
  embedding: 64 * 1024 * 1024,
  /** A non-2xx body only ever becomes a 300-char log excerpt. */
  error: 64 * 1024,
} as const;

/**
 * Read a response body as text, aborting once `maxBytes` have arrived. Streamed
 * (not `res.text()`) so the bytes are counted as they land rather than after the
 * heap already holds them — the same shape as `safeFetch`'s internal `readCapped`,
 * which is module-private there.
 */
async function readBodyCapped(res: Response, maxBytes: number, label: string): Promise<string> {
  if (!res.body) {
    // No stream to meter (a 204, or a synthetic Response in a test): the body is
    // already in memory, so all we can do is refuse to hand on an over-cap one.
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) throw new ProviderResponseTooLargeError(label, maxBytes);
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > maxBytes) {
      // Cancel rather than drain: the point is to stop paying for the bytes.
      await reader.cancel().catch(() => {});
      throw new ProviderResponseTooLargeError(label, maxBytes);
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/**
 * `res.json()` with a byte cap. Every provider handler must use this instead —
 * see the note above. Call it INSIDE the `guardedProviderFetch` handler so the
 * caller's deadline is still armed while the body streams.
 */
export async function readJsonCapped<T = unknown>(
  res: Response,
  label: string,
  maxBytes: number = PROVIDER_BODY_LIMITS.json,
): Promise<T> {
  const text = await readBodyCapped(res, maxBytes, label);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label}: response body was not valid JSON`);
  }
}

// ── lenient model-output parsing (docs/MODEL-BAKEOFF.md adoption item 2) ──────

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * The span from the first `{`/`[` to the LAST matching closer, or undefined.
 *
 * First-to-LAST rather than the depth-counted first-complete-object the benchmark
 * harness uses, deliberately: a depth counter stops at the first balanced value and
 * would silently discard whatever follows it, which is exactly how a lenient parser
 * turns "the model answered twice / kept talking" into a confident wrong answer.
 * Taking the outermost span means trailing garbage stays inside the slice and the
 * strict re-parse below still rejects it.
 */
function outermostJsonSpan(text: string): string | undefined {
  const objStart = text.indexOf("{");
  const arrStart = text.indexOf("[");
  const start =
    objStart < 0 ? arrStart : arrStart < 0 ? objStart : Math.min(objStart, arrStart);
  if (start < 0) return undefined;
  const close = text[start] === "[" ? "]" : "}";
  const end = text.lastIndexOf(close);
  if (end <= start) return undefined;
  return text.slice(start, end + 1);
}

/** A complete ```-fence wrapping the whole response, capture group = its contents. */
const WHOLE_FENCE = /^```[A-Za-z0-9_+.-]*[^\S\r\n]*\r?\n([\s\S]*?)\r?\n?[^\S\r\n]*```$/;

/**
 * Parse a model's `content` into JSON, tolerating a code fence or a leading
 * sentence — but never tolerating a genuinely malformed response.
 *
 * `docs/MODEL-BAKEOFF.md` adoption item 2: the benchmark harness has parsed
 * leniently since it was written, production has not, and the difference is the
 * one thing keeping the bakeoff's quality-and-cost winner unadoptable.
 * `z-ai-glm-5-3-flash` wraps its answer in a ``` ```json ``` fence DESPITE a strict
 * `response_format: {type: "json_schema", strict: true}` — 3 of 82 scoring calls
 * survived a bare `JSON.parse`, so it benchmarks at zero format failures and would
 * fail ~96% of production calls.
 *
 * Three ordered attempts, each ending in a STRICT `JSON.parse`, so nothing here can
 * accept something `JSON.parse` would reject:
 *
 *  1. The content as-is. A well-formed response takes this path and no rule below
 *     can change its result — the ONLY way to add leniency without changing what
 *     already works.
 *  2. The inside of ONE complete fence (it must both open and close, and wrap the
 *     whole response — a stray ``` mid-prose is not a fence).
 *  3. The outermost `{…}`/`[…]` span, for a model that prefixes "Here is the JSON:".
 *
 * What it deliberately does NOT do: repair quotes, strip trailing commas, or accept
 * the first of several values. A truncated response is still a parse failure here
 * (and is named earlier and more precisely by the `finish_reason=length` check), and
 * a model that emitted prose instead of JSON still fails loudly.
 */
export function parseModelJson(content: string): unknown {
  const direct = tryParseJson(content);
  if (direct.ok) return direct.value;

  const trimmed = content.trim();
  const fence = WHOLE_FENCE.exec(trimmed);
  const inner = fence ? fence[1]!.trim() : undefined;

  if (inner !== undefined) {
    const unfenced = tryParseJson(inner);
    if (unfenced.ok) return unfenced.value;
  }

  for (const text of inner !== undefined ? [inner, trimmed] : [trimmed]) {
    const span = outermostJsonSpan(text);
    if (span === undefined) continue;
    const parsed = tryParseJson(span);
    if (parsed.ok) return parsed.value;
  }
  throw new SyntaxError("no JSON value in the model's output");
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
