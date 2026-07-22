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
import { PROVIDER_TIMEOUTS, withProviderTimeout } from "./http.js";

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
 */
async function httpError(res: Response, label: string): Promise<Error> {
  const text = await res.text().catch(() => "");
  if (res.status === 402 || /insufficient[_ ]?(balance|credit|funds)/i.test(text)) {
    return new Error(`Venice billing: insufficient balance (${res.status}) — ${label}: ${text}`);
  }
  return new Error(`${label} failed: ${res.status} ${text}`);
}

export interface VeniceOptions {
  baseUrl?: string;
  payment: PaymentStrategy;
  /** Restrict LLM selection to private/TEE-tier models (spec §9.4). */
  requirePrivate?: boolean;
}

export class VeniceLlm implements LlmProvider {
  readonly id = "venice";
  private readonly base: string;
  constructor(private readonly opts: VeniceOptions) {
    this.base = opts.baseUrl ?? DEFAULT_BASE;
  }

  private async headers(estimateTokens?: number): Promise<Record<string, string>> {
    return { "Content-Type": "application/json", ...(await this.opts.payment.prepare({ estimateTokens })) };
  }

  async models(): Promise<ModelInfo[]> {
    const headers = await this.headers();
    const body = await withProviderTimeout(
      "Venice GET /models",
      PROVIDER_TIMEOUTS.metadata,
      async (signal) => {
        const res = await fetch(`${this.base}/models`, { headers, signal });
        if (!res.ok) throw await httpError(res, "Venice GET /models");
        return (await res.json()) as { data?: any[] };
      },
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
  }): Promise<{ value: T; usage: TokenUsage }> {
    const headers = await this.headers(req.maxTokens);
    const body = await withProviderTimeout(
      "Venice chat/completions",
      PROVIDER_TIMEOUTS.completion,
      async (signal) => {
        const res = await fetch(`${this.base}/chat/completions`, {
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
            // reasoning tokens between us and the JSON.
            venice_parameters: {
              include_venice_system_prompt: false,
              disable_thinking: true,
              strip_thinking_response: true,
            },
          }),
        });
        if (!res.ok) {
          throw await httpError(res, "Venice chat/completions");
        }
        const parsed = (await res.json()) as any;
        await this.opts.payment.settle(res.headers);
        return parsed;
      },
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

  async embed(texts: string[], model?: string): Promise<number[][]> {
    const headers = await this.headers();
    const body = await withProviderTimeout(
      "Venice embeddings",
      PROVIDER_TIMEOUTS.embedding,
      async (signal) => {
        const res = await fetch(`${this.base}/embeddings`, {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify({ model: model ?? "text-embedding-bge-m3", input: texts }),
        });
        if (!res.ok) throw await httpError(res, "Venice embeddings");
        return (await res.json()) as { data?: { embedding: number[] }[] };
      },
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
    opts?: { model?: string },
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

    const headers = await this.opts.payment.prepare({});
    const body = await withProviderTimeout(
      "Venice STT",
      PROVIDER_TIMEOUTS.stt,
      async (signal) => {
        const res = await fetch(`${this.base}/audio/transcriptions`, {
          method: "POST",
          headers, // do NOT set Content-Type; fetch sets the multipart boundary
          body: form,
          signal,
        });
        if (!res.ok) throw await httpError(res, "Venice STT");
        return (await res.json()) as { text?: unknown; language?: unknown };
      },
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
