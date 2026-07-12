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

const DEFAULT_BASE = "https://api.venice.ai/api/v1";
/** Venice STT hard limit: 25 MB (spec §9.4, §3.7). */
export const VENICE_STT_MAX_BYTES = 25 * 1024 * 1024;

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
    const res = await fetch(`${this.base}/models`, { headers: await this.headers() });
    if (!res.ok) throw new Error(`Venice GET /models failed: ${res.status}`);
    const body = (await res.json()) as { data?: any[] };
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
  }): Promise<{ value: T; usage: TokenUsage }> {
    const res = await fetch(`${this.base}/chat/completions`, {
      method: "POST",
      headers: await this.headers(req.maxTokens),
      body: JSON.stringify({
        model: req.model,
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: req.schemaName, strict: true, schema: req.schema },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Venice chat/completions failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as any;
    await this.opts.payment.settle(res.headers);
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("Venice returned no content");
    return {
      value: JSON.parse(content) as T,
      usage: {
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
        totalTokens: body.usage?.total_tokens ?? 0,
      },
    };
  }

  async embed(texts: string[], model?: string): Promise<number[][]> {
    const res = await fetch(`${this.base}/embeddings`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ model: model ?? "text-embedding-bge-m3", input: texts }),
    });
    if (!res.ok) throw new Error(`Venice embeddings failed: ${res.status}`);
    const body = (await res.json()) as { data?: { embedding: number[] }[] };
    return (body.data ?? []).map((d) => d.embedding);
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
    const res = await fetch(`${this.base}/audio/transcriptions`, {
      method: "POST",
      headers, // do NOT set Content-Type; fetch sets the multipart boundary
      body: form,
    });
    if (!res.ok) throw new Error(`Venice STT failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { text?: string; language?: string };
    return { text: body.text ?? "", language: body.language };
  }
}
