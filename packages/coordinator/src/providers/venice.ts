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
  PROVIDER_TIMEOUTS,
  ProviderHttpError,
  providerHttpError,
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
 */
function isReasoningMandatory(err: unknown): boolean {
  return (
    err instanceof ProviderHttpError &&
    err.status === 400 &&
    /reasoning is mandatory|cannot be disabled/i.test(err.bodyExcerpt)
  );
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
   * Keyed by model id rather than by role because it is a property of the MODEL,
   * and one adapter instance serves every role that routes to Venice —
   * `completeStructured` only knows which model it was handed.
   */
  disableThinking?: Readonly<Record<string, boolean>>;
}

export class VeniceLlm implements LlmProvider {
  readonly id = "venice";
  private readonly base: string;
  /**
   * Whether to send `disable_thinking` for a given model id. Seeded from config
   * and corrected at runtime the first time a model refuses it (see
   * {@link isReasoningMandatory}) — the catalogue cannot be trusted for this:
   * `z-ai-glm-5-3-flash` advertises `reasoningEffortOptions` including "none"
   * and then rejects both that and `disable_thinking` on every request.
   */
  private readonly thinking = new Map<string, boolean>();
  constructor(private readonly opts: VeniceOptions) {
    this.base = opts.baseUrl ?? DEFAULT_BASE;
    for (const [model, disable] of Object.entries(opts.disableThinking ?? {})) {
      this.thinking.set(model, disable);
    }
  }

  /** Default true: today's behaviour, and correct for every model but the odd one. */
  private disablesThinking(model: string): boolean {
    return this.thinking.get(model) ?? true;
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
            return (await res.json()) as { data?: any[] };
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
      return await this.chat<T>(req, this.disablesThinking(req.model));
    } catch (err) {
      // A model that reasons unconditionally refuses `disable_thinking` on EVERY
      // request, so this is not a transient failure to back off from — it is a
      // fact about the model, learned once and remembered for the process. Left
      // undetected it is a total outage for that model: with the parameter sent
      // unconditionally, pointing `models.match` at such a model scores nothing
      // at all, and the operator sees provider errors rather than a bad match.
      // Operators can also set it ahead of time (`models.<role>.disable_thinking
      // = false`) and skip the wasted call entirely.
      if (!isReasoningMandatory(err) || !this.disablesThinking(req.model)) throw err;
      this.thinking.set(req.model, false);
      console.warn(
        `[llm] ${req.model} rejects venice_parameters.disable_thinking ("reasoning is mandatory ` +
          `for this endpoint") — retrying without it and sending it no more this run. Set ` +
          `models.<role>.disable_thinking = false in coordinator.toml to skip this probe. ` +
          `Note that reasoning tokens are billed even though strip_thinking_response hides them.`,
      );
      return await this.chat<T>(req, false);
    }
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
    disableThinking: boolean,
  ): Promise<{ value: T; usage: TokenUsage }> {
    const headers = await this.headers(req.maxTokens);
    const body = await withProviderTimeout(
      "Venice chat/completions",
      PROVIDER_TIMEOUTS.completion,
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
              max_tokens: req.maxTokens ?? 4096,
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
                ...(disableThinking ? { disable_thinking: true } : {}),
                strip_thinking_response: true,
              },
            }),
          },
          this.opts.net ?? {},
          async (res) => {
            if (!res.ok) {
              throw await httpError(res, "Venice chat/completions");
            }
            const parsed = (await res.json()) as any;
            await this.opts.payment.settle(res.headers);
            return parsed;
          },
        ),
      req.signal,
    );
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new ProviderContractError(this.id, req.schemaName, req.model, "no string content");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ProviderContractError(this.id, req.schemaName, req.model, "output was not valid JSON");
    }
    return {
      value: validateProviderValue<T>(
        parsed,
        { provider: this.id, schemaName: req.schemaName, model: req.model },
        req.validate,
      ),
      usage: {
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
        totalTokens: body.usage?.total_tokens ?? 0,
      },
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
            return (await res.json()) as { data?: { embedding: number[] }[] };
          },
        ),
      callerSignal,
    );
    const embedModel = model ?? "text-embedding-bge-m3";
    return (body.data ?? []).map((d, i) => {
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
      return emb;
    });
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
            return (await res.json()) as { text?: unknown; language?: unknown };
          },
        ),
      opts?.signal,
    );
    if (body.text !== undefined && typeof body.text !== "string") {
      throw new ProviderContractError(this.id, "stt", opts?.model ?? "openai/whisper-large-v3", "text was not a string");
    }
    return {
      text: typeof body.text === "string" ? body.text : "",
      language: typeof body.language === "string" ? body.language : undefined,
    };
  }
}
