/**
 * Venice.ai adapters (spec §9.4). OpenAI-compatible endpoints under
 * https://api.venice.ai/api/v1 with `Authorization: Bearer <key>` (ApiKeyPayment).
 *
 * Model ids / context sizes / supportsResponseSchema / private flags are VOLATILE
 * — always queried at runtime via GET /models, never hardcoded (spec §15).
 */
import type {
  SttProvider,
  LlmProvider,
  ModelInfo,
  PaymentStrategy,
  TokenUsage,
} from "./types.js";
import { ProviderContractError, validateProviderValue } from "./types.js";
import {
  PROVIDER_BODY_LIMITS,
  PROVIDER_TIMEOUTS,
  completionTimeoutMs,
  ProviderHttpError,
  parseModelJson,
  providerHttpError,
  readJsonCapped,
  withProviderTimeout,
  withUncancellableDeadline,
} from "./http.js";
import { guardedProviderFetch, type ProviderNetPolicy } from "../net/safe-fetch.js";

const DEFAULT_BASE = "https://api.venice.ai/api/v1";
/** Venice STT hard limit: 25 MB (spec §9.4, §3.7). */
export const VENICE_STT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * A 402 (or a body naming an insufficient balance) is a billing problem, not a
 * schema/network hiccup — the message is worded so coordinator.ts's
 * errorCategory() classifies it as "provider_billing" rather than the
 * catch-all "processing_error". Retrying immediately can't fix a depleted
 * account; the job runner's long-tail backoff gives an operator time to top up
 * before it poisons (user feedback 2026-07-21).
 *
 * Classification, the status/body excerpt, and the LOG all live in
 * {@link providerHttpError} now (shared with Routstr): a provider failure has to
 * be visible in the coordinator log even when a caller swallows the exception,
 * which is what made the 2026-07-24 incident undiagnosable from the log alone.
 */
async function httpError(res: Response, label: string, tag: "llm" | "stt" = "llm"): Promise<Error> {
  return providerHttpError(res, label, tag);
}

/**
 * Venice's refusal when a model reasons unconditionally.
 *
 * Matched on the message rather than the status alone: 400 covers every
 * malformed request, and turning an unrelated 400 into a silent retry with
 * different parameters would hide real bugs.
 *
 * NOTE (measured 2026-09-14): Venice no longer answers `z-ai-glm-5-3-flash` this
 * way. The refusal is still handled — it is cheap and other models may yet send
 * it — but it is no longer the only shape the fact arrives in; see
 * {@link VeniceTruncationError} and {@link VeniceLlm.learnFrom}.
 */
function isReasoningMandatory(err: unknown): boolean {
  return (
    err instanceof ProviderHttpError &&
    err.status === 400 &&
    /reasoning is mandatory|cannot be disabled/i.test(err.bodyExcerpt)
  );
}

/** The adapter's own completion ceiling when a caller names none. */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * How ONE Venice model has to be driven.
 *
 * Every field defaults to what this adapter has always sent, so a model nobody
 * has characterised is requested byte-for-byte as before —
 * `deepseek-v4-flash-0731`, the deployed scorer, included. Per-model rather than
 * per-role because these are properties of the MODEL, and one adapter instance
 * serves every role that routes to Venice; `completeStructured` only knows which
 * model it was handed.
 */
export interface VeniceModelTraits {
  /**
   * Send `venice_parameters.disable_thinking: true`.
   *
   * False for a model that reasons unconditionally. On `z-ai-glm-5-3-flash` the
   * parameter is not merely ignored — measured against live Venice 2026-09-14, a
   * request carrying it (or `reasoning_effort: "none"`) comes back having spent
   * the ENTIRE budget on reasoning with no answer at all: 12000/12000 completion
   * tokens, all of them reasoning, empty content, `finish_reason=length`. Four of
   * four such calls. The same request with the parameter omitted succeeded four
   * of four. So this is not an optimisation for that model, it is the difference
   * between every call working and every call failing — and every failed call is
   * still billed for its 12000 reasoning tokens.
   */
  disableThinking: boolean;
  /**
   * Completion tokens to add on top of the caller's `maxTokens`.
   *
   * A caller's `maxTokens` is a budget for the ANSWER (`batchMaxTokens()` sizes
   * it from the number of candidates it wants scored). Venice bills reasoning out
   * of the same `max_tokens` pool, so on a reasoning model that budget is really
   * being shared, and the JSON gets whatever the chain-of-thought left behind. A
   * truncated batch is not a lost row: it is unparseable JSON, so the whole batch
   * fails and rides the full paid retry schedule.
   *
   * Measured on the shape production actually sends (reverse batch, K=10, Slovak,
   * `batchMaxTokens(10)` = 12000), `z-ai-glm-5-3-flash` spent 3013 / 3456 / 4443 /
   * 5297 / 5655 / 6088 tokens on reasoning across six calls — up to 6088 of the
   * 12000 that were meant for the answer, leaving it finishing at 89% of the
   * ceiling on the worst one. It fits today and truncates on any longer-than-usual
   * trace. Reserving the reasoning separately is what makes that not a coin flip.
   *
   * `max_tokens` is a CEILING, not a charge — an unused reserve costs nothing.
   */
  reasoningReserveTokens: number;
}

/** Today's behaviour, and correct for every model deployed so far. */
export const DEFAULT_MODEL_TRAITS: Readonly<VeniceModelTraits> = Object.freeze({
  disableThinking: true,
  reasoningReserveTokens: 0,
});

/**
 * The reserve installed when the adapter learns, at runtime, that a model reasons
 * whether or not it was asked to.
 *
 * 8000 is ~1.3x the largest reasoning trace measured on the biggest shape
 * production sends (6088; see {@link VeniceModelTraits.reasoningReserveTokens}),
 * which puts the K=10 reverse batch at a 20000-token ceiling. Deliberately
 * generous: the reserve is only a ceiling, and the failure it prevents costs a
 * whole batch plus its retries.
 */
export const DEFAULT_REASONING_RESERVE_TOKENS = 8000;

const EMPTY_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 };

const nonNegative = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;

/**
 * Venice's usage block, read so that reasoning cannot go unbilled.
 *
 * Verified against live Venice 2026-09-14 on `z-ai-glm-5-3-flash`:
 * `completion_tokens` 8112 with `completion_tokens_details.reasoning_tokens` 4443
 * and ~3669 tokens of actual content — i.e. reasoning is reported INSIDE
 * `completion_tokens`, and the existing mapping already bills for it. It is
 * surfaced separately anyway because it is invisible in the response body
 * (`strip_thinking_response` removes the text but not the charge), and a cost
 * model that cannot see it cannot explain why a "cheap per token" model is dear
 * per call.
 *
 * The `total_tokens` cross-check guards the one way this could silently
 * UNDER-bill: if a gateway ever reported `completion_tokens` as content only,
 * prompt+completion would fall short of `total_tokens` and every figure derived
 * from it would be low by exactly the reasoning it hid.
 */
function readUsage(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as Record<string, any>;
  const promptTokens = nonNegative(u.prompt_tokens);
  const reportedTotal = nonNegative(u.total_tokens);
  const completionTokens = Math.max(nonNegative(u.completion_tokens), reportedTotal - promptTokens);
  return {
    promptTokens,
    completionTokens,
    // A provider that omits `total_tokens` used to report 0 here, which reads as
    // "this call was free" to anything summing it.
    totalTokens: Math.max(reportedTotal, promptTokens + completionTokens),
    reasoningTokens: nonNegative(u.completion_tokens_details?.reasoning_tokens),
  };
}

/** Sum two usage records; a retry's cost is the sum of every attempt, not the last. */
function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
  };
}

/**
 * A completion that stopped at the token ceiling, carrying the usage that
 * explains why it stopped there.
 *
 * Still a {@link ProviderContractError}, so every caller (job runner
 * classification, poison handling) treats it exactly as before. The extra fields
 * exist so the adapter itself can tell a model that ran out of room for its
 * ANSWER from one that never got to the answer at all because it spent the budget
 * reasoning — and the tokens the doomed attempt already billed us for.
 */
export class VeniceTruncationError extends ProviderContractError {
  constructor(
    schemaName: string,
    model: string,
    readonly ceiling: number,
    readonly usage: TokenUsage,
    detail: string,
  ) {
    super("venice", schemaName, model, detail);
    this.name = "VeniceTruncationError";
  }
}

export interface VeniceOptions {
  baseUrl?: string;
  payment: PaymentStrategy;
  /** Restrict LLM selection to private/TEE-tier models (spec §9.4). */
  requirePrivate?: boolean;
  /** DNS-pinning policy for outbound requests (audit R22). Default: pin + public-only. */
  net?: ProviderNetPolicy;
  /**
   * Per-model-id override for `venice_parameters.disable_thinking`, from
   * `models.<role>.disable_thinking`. Absent = true, which is what every model
   * benchmarked before 2026-08-26 wanted and what this adapter always sent.
   *
   * Kept as its own option because `main.ts` wires this one key from
   * `coordinator.toml`; it is the narrow spelling of
   * {@link VeniceModelTraits.disableThinking} and is applied last, so an explicit
   * operator setting wins over anything in {@link modelTraits}.
   */
  disableThinking?: Readonly<Record<string, boolean>>;
  /**
   * Per-model-id request traits (see {@link VeniceModelTraits}). Absent fields
   * keep {@link DEFAULT_MODEL_TRAITS}, so a model that isn't listed is requested
   * exactly as it is today.
   *
   * The adapter also LEARNS these from a model's own behaviour, so setting them
   * is an optimisation (it skips one doomed, billed call) and a way to be
   * explicit — not a requirement for driving a model that needs them.
   */
  modelTraits?: Readonly<Record<string, Readonly<Partial<VeniceModelTraits>>>>;
}

export class VeniceLlm implements LlmProvider {
  readonly id = "venice";
  private readonly base: string;
  /**
   * How each model id must be driven. Seeded from config and corrected at runtime
   * from the model's own behaviour (see {@link learnFrom}) — `GET /models` cannot
   * be trusted for any of it: `z-ai-glm-5-3-flash` advertises
   * `reasoningEffortOptions` including "none" and `supportsReasoningEffort: true`,
   * and then reasons flat out regardless of either.
   */
  private readonly traits = new Map<string, VeniceModelTraits>();
  constructor(private readonly opts: VeniceOptions) {
    this.base = opts.baseUrl ?? DEFAULT_BASE;
    for (const [model, patch] of Object.entries(opts.modelTraits ?? {})) {
      this.setTraits(model, patch);
    }
    // Last, so `models.<role>.disable_thinking` — the key an operator can
    // actually set today — overrides a trait block that says otherwise.
    for (const [model, disable] of Object.entries(opts.disableThinking ?? {})) {
      this.setTraits(model, { disableThinking: disable });
    }
  }

  /** Defaults are today's behaviour, so an uncharacterised model is unchanged. */
  private traitsFor(model: string): VeniceModelTraits {
    return this.traits.get(model) ?? DEFAULT_MODEL_TRAITS;
  }

  private setTraits(model: string, patch: Readonly<Partial<VeniceModelTraits>>): VeniceModelTraits {
    const next: VeniceModelTraits = { ...this.traitsFor(model), ...patch };
    this.traits.set(model, next);
    return next;
  }

  /**
   * Payment headers, under their OWN deadline. This runs BEFORE
   * `withProviderTimeout` arms the request deadline, so an unbounded `prepare()` —
   * a CashuPayment whose mint stops answering — would hang the awaiting job
   * forever: no timeout, no failure, no log, and (because jobs drain serially) no
   * further work of any kind. Bounded here so the worst case is one failed job.
   */
  private async headers(estimateTokens?: number): Promise<Record<string, string>> {
    const paid = await withUncancellableDeadline("Venice payment.prepare", PROVIDER_TIMEOUTS.payment, () =>
      this.opts.payment.prepare({ estimateTokens }),
    );
    return { "Content-Type": "application/json", ...paid };
  }

  async models(): Promise<ModelInfo[]> {
    const headers = await this.headers();
    const body = await withProviderTimeout(
      "Venice GET /models",
      PROVIDER_TIMEOUTS.metadata,
      (signal) =>
        guardedProviderFetch(
          `${this.base}/models`,
          { headers, signal },
          this.opts.net ?? {},
          async (res) => {
            if (!res.ok) throw await httpError(res, "Venice GET /models");
            return await readJsonCapped<{ data?: any[] }>(res, "Venice GET /models");
          },
        ),
    );
    const models = (body.data ?? []).map((m) => {
      const spec = m.model_spec ?? m.spec ?? {};
      const caps = spec.capabilities ?? m.capabilities ?? {};
      return {
        id: m.id,
        contextLength: spec.availableContextTokens ?? m.context_length,
        supportsResponseSchema:
          caps.supportsResponseSchema ?? caps.response_schema ?? false,
        private: spec.privacy === "private" || spec.tee === true || m.private === true,
      } satisfies ModelInfo;
    });
    return this.opts.requirePrivate ? models.filter((m) => m.private) : models;
  }

  async completeStructured<T>(req: {
    system: string;
    user: string;
    schema: object;
    schemaName: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
    validate?: (raw: unknown) => T;
    signal?: AbortSignal;
  }): Promise<{ value: T; usage: TokenUsage }> {
    try {
      return await this.chat<T>(req, this.traitsFor(req.model));
    } catch (err) {
      // How a model must be driven is a FACT about it, not a transient failure to
      // back off from: learned once from its own behaviour and remembered for the
      // process. Left undetected it is a total outage for that model — every
      // scoring call fails, and the operator sees provider errors rather than a
      // bad match. Only one correction+retry per call: if the corrected request
      // fails too, that is a real error and must be loud, not the first rung of
      // an unbounded (and billed) retry ladder.
      const corrected = this.learnFrom(err, req.model);
      if (!corrected) throw err;
      // The doomed attempt still generated — and Venice still billed us for —
      // every reasoning token it produced before it was cut off. Fold that into
      // the usage the caller sees, or a cost figure computed from it reports only
      // the attempt that worked and understates the call by the whole probe.
      const spent = err instanceof VeniceTruncationError ? err.usage : EMPTY_USAGE;
      const out = await this.chat<T>(req, corrected);
      return { value: out.value, usage: addUsage(spent, out.usage) };
    }
  }

  /**
   * Turn a failure that is really a statement about the MODEL into corrected
   * traits, or `undefined` when the failure is not one we know how to answer (in
   * which case it propagates unchanged — retrying a schema error with different
   * parameters would turn a loud bug into a quiet one).
   */
  private learnFrom(err: unknown, model: string): VeniceModelTraits | undefined {
    const t = this.traitsFor(model);

    // (a) The refusal arriving as Venice's own 400. `z-ai-glm-5-3-flash` answered
    // this way in 2026-08; it no longer does, but the branch is kept because the
    // refusal is a documented Venice behaviour and detecting it costs nothing.
    if (isReasoningMandatory(err)) {
      if (!t.disableThinking) return undefined; // already dropped; nothing left to try
      console.warn(
        `[llm] ${model} rejects venice_parameters.disable_thinking ("reasoning is mandatory ` +
          `for this endpoint") — retrying without it, reserving ${DEFAULT_REASONING_RESERVE_TOKENS} ` +
          `completion tokens for reasoning, and sending it no more this run. Set ` +
          `models.<role>.disable_thinking = false in coordinator.toml to skip this probe. ` +
          `Note that reasoning tokens are billed even though strip_thinking_response hides them.`,
      );
      return this.setTraits(model, {
        disableThinking: false,
        reasoningReserveTokens: Math.max(t.reasoningReserveTokens, DEFAULT_REASONING_RESERVE_TOKENS),
      });
    }

    // (b) The same fact without a 400, which is how `z-ai-glm-5-3-flash` states it
    // now: the request is accepted, the model reasons anyway, and the answer is
    // whatever fits in what the reasoning left. A `finish_reason=length` whose
    // usage reports reasoning tokens is therefore not "the prompt asks for too
    // much output" — it is "the budget was shared with a chain of thought".
    //
    // Requiring reasoningTokens > 0 is what keeps an ordinary truncation (a
    // non-reasoning model genuinely out of room, which wants a bigger
    // batchMaxTokens, not a provider retry) surfacing as the error it is.
    if (err instanceof VeniceTruncationError && (err.usage.reasoningTokens ?? 0) > 0) {
      const reserve = Math.max(t.reasoningReserveTokens, DEFAULT_REASONING_RESERVE_TOKENS);
      // Sending disable_thinking is the prime suspect and the cheapest thing to
      // stop doing: on GLM 5.3 Flash it does not reduce reasoning, it makes the
      // model spend the ENTIRE budget on it and return nothing (4/4 calls), where
      // the same request without it answered 4/4.
      if (!t.disableThinking && reserve === t.reasoningReserveTokens) return undefined;
      console.warn(
        `[llm] ${model} spent ${err.usage.reasoningTokens} of ${err.usage.completionTokens} ` +
          `completion tokens on reasoning and was cut off at ${err.ceiling}` +
          (t.disableThinking
            ? ` despite venice_parameters.disable_thinking — it reasons unconditionally, so the ` +
              `parameter only starves the answer. Dropping it`
            : ` — the answer budget is being shared with a chain of thought. Raising the reserve`) +
          ` and reserving ${reserve} completion tokens for reasoning from here on. Reasoning ` +
          `tokens are billed even though strip_thinking_response hides them.`,
      );
      return this.setTraits(model, { disableThinking: false, reasoningReserveTokens: reserve });
    }

    return undefined;
  }

  private async chat<T>(
    req: {
      system: string;
      user: string;
      schema: object;
      schemaName: string;
      model: string;
      temperature?: number;
      maxTokens?: number;
      validate?: (raw: unknown) => T;
      signal?: AbortSignal;
    },
    traits: VeniceModelTraits,
  ): Promise<{ value: T; usage: TokenUsage }> {
    // The caller's budget is for the ANSWER. On a model that reasons, the
    // reasoning is billed out of the same `max_tokens` pool, so the ceiling we
    // actually send is the answer budget PLUS the model's reserve — which is 0
    // for every model characterised so far, leaving their requests untouched.
    const answerBudget = req.maxTokens ?? DEFAULT_MAX_TOKENS;
    const ceiling = answerBudget + traits.reasoningReserveTokens;
    const headers = await this.headers(ceiling);
    const body = await withProviderTimeout(
      "Venice chat/completions",
      // Scaled by the output budget, not flat — see completionTimeoutMs. It is
      // scaled by the CEILING: a reasoning model is slower for exactly the reason
      // its ceiling is higher, and a deadline sized for the answer alone would cut
      // off the very calls the reserve exists to let finish.
      completionTimeoutMs(ceiling),
      (signal) =>
        guardedProviderFetch(
          `${this.base}/chat/completions`,
          {
            method: "POST",
            headers,
            signal,
            body: JSON.stringify({
              model: req.model,
              temperature: req.temperature ?? 0.2,
              // Reasoning models otherwise burn the whole budget on chain-of-thought and
              // return empty content; give structured output real headroom.
              max_tokens: ceiling,
              messages: [
                { role: "system", content: req.system },
                { role: "user", content: req.user },
              ],
              response_format: {
                type: "json_schema",
                json_schema: { name: req.schemaName, strict: true, schema: req.schema },
              },
              // Our system prompt is authoritative (no Venice persona), and we don't want
              // reasoning tokens between us and the JSON. `disable_thinking` is omitted
              // — not sent as false — for models that reject it outright; see
              // {@link VeniceOptions.disableThinking}. `strip_thinking_response` is safe
              // on both kinds and keeps chain-of-thought out of the parsed content.
              venice_parameters: {
                include_venice_system_prompt: false,
                ...(traits.disableThinking ? { disable_thinking: true } : {}),
                strip_thinking_response: true,
              },
            }),
          },
          this.opts.net ?? {},
          async (res) => {
            if (!res.ok) {
              throw await httpError(res, "Venice chat/completions");
            }
            const parsed = await readJsonCapped<any>(res, "Venice chat/completions");
            await this.opts.payment.settle(res.headers);
            return parsed;
          },
        ),
      req.signal,
    );
    const usage = readUsage(body.usage);
    const content = body.choices?.[0]?.message?.content;
    // An empty string is what a model that spent its whole budget reasoning
    // returns, so the truncation check below has to come first for it; a
    // NON-string content is a shape failure and has nothing to do with budgets.
    if (typeof content !== "string" && body.choices?.[0]?.finish_reason !== "length") {
      throw new ProviderContractError(this.id, req.schemaName, req.model, "no string content");
    }
    // A response cut off at the token ceiling is unparseable JSON, and used to be
    // indistinguishable in the logs from a model that emitted garbage — the two want
    // opposite responses (raise the budget vs. fix the prompt), so name it. Checked
    // BEFORE the parse so the diagnosis survives even if a truncation happens to
    // land on a syntactically complete prefix.
    const finish = body.choices?.[0]?.finish_reason;
    if (finish === "length") {
      // Name reasoning when it is what consumed the budget. Without it the log
      // says "raise the ceiling" for a model whose problem is that it is reasoning
      // 6000 tokens per call inside a budget sized for the answer — and those are
      // different fixes. `completeStructured` reads the same two numbers to decide
      // whether it can correct the request and retry.
      const spentOnReasoning = usage.reasoningTokens ?? 0;
      throw new VeniceTruncationError(
        req.schemaName,
        req.model,
        ceiling,
        usage,
        `response truncated at the ${ceiling}-token ceiling (finish_reason=length)` +
          (spentOnReasoning > 0
            ? `; ${spentOnReasoning} of ${usage.completionTokens} completion tokens went on ` +
              `reasoning, which is billed and drawn from the same budget as the answer — raise ` +
              `this model's reasoningReserveTokens (currently ${traits.reasoningReserveTokens})`
            : ""),
      );
    }
    // Only reachable for a non-"length" finish, so content is a string by the
    // check above; narrow it for the compiler.
    if (typeof content !== "string") {
      throw new ProviderContractError(this.id, req.schemaName, req.model, "no string content");
    }
    // Lenient only in the ways a model actually malforms JSON — a ```json fence, a
    // leading sentence — and strict about everything else; see {@link parseModelJson}.
    // A bare `JSON.parse` here is what once made docs/MODEL-BAKEOFF.md's
    // quality-and-cost winner unadoptable: `z-ai-glm-5-3-flash` fenced its output
    // despite `strict: true`, so it would have failed ~96% of production calls
    // while benchmarking at zero format failures.
    let parsed: unknown;
    try {
      parsed = parseModelJson(content);
    } catch {
      throw new ProviderContractError(this.id, req.schemaName, req.model, "output was not valid JSON");
    }
    return {
      value: validateProviderValue<T>(
        parsed,
        { provider: this.id, schemaName: req.schemaName, model: req.model },
        req.validate,
      ),
      usage,
    };
  }

  async embed(texts: string[], model?: string, callerSignal?: AbortSignal): Promise<number[][]> {
    const headers = await this.headers();
    const body = await withProviderTimeout(
      "Venice embeddings",
      PROVIDER_TIMEOUTS.embedding,
      (signal) =>
        guardedProviderFetch(
          `${this.base}/embeddings`,
          {
            method: "POST",
            headers,
            signal,
            body: JSON.stringify({ model: model ?? "text-embedding-bge-m3", input: texts }),
          },
          this.opts.net ?? {},
          async (res) => {
            if (!res.ok) throw await httpError(res, "Venice embeddings");
            return await readJsonCapped<{ data?: { embedding?: unknown; index?: unknown }[] }>(
              res,
              "Venice embeddings",
              // The largest body we legitimately read: a whole roster in one call.
              PROVIDER_BODY_LIMITS.embedding,
            );
          },
        ),
      callerSignal,
    );
    const embedModel = model ?? "text-embedding-bge-m3";
    const rows = body.data ?? [];

    // COUNT first (2026-09-04 audit). A SHORT response used to be silently
    // accepted: the caller does `embeddings[i]!` per roster miss, and a missing row
    // makes that `undefined`, which is stored as `JSON.stringify(undefined)` — the
    // literal string `undefined`, not JSON — and then throws inside `utf8ToBytes`
    // on the next read. That fails `match_recompute` AND re-bills this embed call
    // on every retry, for a fault that is invisible here.
    if (rows.length !== texts.length) {
      throw new ProviderContractError(
        this.id,
        "embeddings",
        embedModel,
        `expected ${texts.length} vectors, got ${rows.length}`,
      );
    }

    // ORDER second. OpenAI's embeddings contract gives every row a 0-based `index`
    // naming the input it belongs to, and does NOT promise the array is sorted;
    // this used to map positionally and ignore `index` entirely. A gateway that
    // reorders rows therefore handed attendee A's vector to attendee B — silently,
    // with no error anywhere. Above the 50-attendee prefilter threshold that is not
    // a cosmetic mixup: every attendee gets someone else's top-30 candidate set,
    // and the only symptom is matches that feel subtly wrong.
    //
    // `index` is honoured when present and the position is used as the fallback (a
    // gateway that omits it is the pre-existing behaviour, now at least length-
    // checked). A duplicate or out-of-range `index` is a contract error rather than
    // a last-write-wins overwrite, which would reintroduce the same silent swap.
    const out = new Array<number[]>(texts.length);
    const seen = new Set<number>();
    rows.forEach((d, i) => {
      const declared = d?.index;
      const idx =
        declared === undefined || declared === null
          ? i
          : typeof declared === "number" && Number.isInteger(declared)
            ? declared
            : -1;
      if (idx < 0 || idx >= texts.length || seen.has(idx)) {
        throw new ProviderContractError(
          this.id,
          "embeddings",
          embedModel,
          `row ${i}: unusable index ${String(declared)} (${seen.has(idx) ? "duplicate" : "out of range"})`,
        );
      }
      seen.add(idx);
      const emb = d?.embedding;
      if (
        !Array.isArray(emb) ||
        emb.length === 0 ||
        !emb.every((x) => typeof x === "number" && Number.isFinite(x))
      ) {
        throw new ProviderContractError(
          this.id,
          "embeddings",
          embedModel,
          `row ${i}: malformed embedding vector`,
        );
      }
      out[idx] = emb;
    });
    return out;
  }
}

export class VeniceStt implements SttProvider {
  readonly id = "venice-stt";
  private readonly base: string;
  constructor(private readonly opts: VeniceOptions) {
    this.base = opts.baseUrl ?? DEFAULT_BASE;
  }

  async capabilities(): Promise<{ models: string[]; maxUploadBytes: number }> {
    return { models: ["openai/whisper-large-v3"], maxUploadBytes: VENICE_STT_MAX_BYTES };
  }

  async transcribe(
    audio: { data: Uint8Array; mime: string; language?: string },
    opts?: { model?: string; signal?: AbortSignal },
  ): Promise<{ text: string; language?: string }> {
    if (audio.data.length > VENICE_STT_MAX_BYTES) {
      throw new Error(
        `audio exceeds Venice STT limit (${audio.data.length} > ${VENICE_STT_MAX_BYTES}); segment first`,
      );
    }
    const form = new FormData();
    form.append(
      "file",
      new Blob([Buffer.from(audio.data)], { type: audio.mime }),
      "audio.ogg",
    );
    form.append("model", opts?.model ?? "openai/whisper-large-v3");
    if (audio.language) form.append("language", audio.language);

    // Bounded like VeniceLlm.headers(): prepare() runs outside the STT deadline.
    const headers = await withUncancellableDeadline(
      "Venice STT payment.prepare",
      PROVIDER_TIMEOUTS.payment,
      () => this.opts.payment.prepare({}),
    );
    const body = await withProviderTimeout(
      "Venice STT",
      PROVIDER_TIMEOUTS.stt,
      (signal) =>
        guardedProviderFetch(
          `${this.base}/audio/transcriptions`,
          {
            method: "POST",
            headers, // do NOT set Content-Type; fetch sets the multipart boundary
            body: form,
            signal,
          },
          this.opts.net ?? {},
          async (res) => {
            if (!res.ok) throw await httpError(res, "Venice STT", "stt");
            return await readJsonCapped<{ text?: unknown; language?: unknown }>(res, "Venice STT");
          },
        ),
      opts?.signal,
    );
    // An ABSENT `text` is a contract error, not an empty transcript (2026-09-04
    // audit). It used to become `""`, and transcribe.ts caches a transcript by blob
    // sha256 FOREVER — so one transient glitch on the provider's side permanently
    // discarded an intro the attendee had recorded, indistinguishable from silence,
    // with not one log line to say so. A wrong-TYPED `text` already threw; this is
    // the same fault and gets the same treatment, so the job retries instead.
    if (typeof body.text !== "string") {
      throw new ProviderContractError(
        this.id,
        "stt",
        opts?.model ?? "openai/whisper-large-v3",
        body.text === undefined ? "response carried no `text` field" : "text was not a string",
      );
    }
    return {
      text: body.text,
      language: typeof body.language === "string" ? body.language : undefined,
    };
  }
}
