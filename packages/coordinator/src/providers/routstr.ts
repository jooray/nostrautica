/**
 * Routstr LLM adapter (spec §9.4, v2). Decentralized, Cashu-paid, OpenAI-compatible
 * nodes. Node base URL from config or discovered via Nostr kind 38421 provider
 * announcements. `GET /v1/models` (includes sats_pricing) and `POST
 * /v1/chat/completions` are pass-through OpenAI — structured output works iff the
 * upstream model supports it (verify per node at attach time).
 *
 * STT stays on Venice/local (Routstr has no STT today) — which is why STT and LLM
 * are separately configurable.
 */
import type { LlmProvider, ModelInfo, PaymentStrategy, TokenUsage } from "./types.js";
import { ProviderContractError, validateProviderValue } from "./types.js";

export interface RoutstrOptions {
  nodeUrl: string; // e.g. https://api.routstr.com/v1
  payment: PaymentStrategy; // CashuPayment (or ApiKeyPayment for a balance key)
}

export class RoutstrLlm implements LlmProvider {
  readonly id = "routstr";
  constructor(private readonly opts: RoutstrOptions) {}

  private base(): string {
    return this.opts.nodeUrl.replace(/\/+$/, "");
  }

  async models(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.base()}/models`);
    if (!res.ok) throw new Error(`Routstr GET /models failed: ${res.status}`);
    const body = (await res.json()) as { data?: any[] };
    return (body.data ?? []).map((m) => ({
      id: m.id,
      contextLength: m.context_length,
      supportsResponseSchema: m.supports_response_schema ?? false,
      satsPricing: m.sats_pricing,
    }));
  }

  /** Accepted mints etc. from the node's /v1/info (spec §9.4). */
  async info(): Promise<any> {
    const res = await fetch(`${this.base()}/info`);
    return res.ok ? res.json() : {};
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
    const headers = {
      "Content-Type": "application/json",
      ...(await this.opts.payment.prepare({ estimateTokens: req.maxTokens })),
    };
    let res: Response;
    try {
      res = await fetch(`${this.base()}/chat/completions`, {
        method: "POST",
        headers,
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
    } catch (e) {
      // Network failure after prepare(): the reserved proofs never reach a
      // settle() — account for them (audit COORD-5).
      await this.opts.payment.fail?.().catch(() => {});
      throw e;
    }
    if (!res.ok) {
      await this.opts.payment.fail?.().catch(() => {}); // COORD-5, as above
      throw new Error(`Routstr chat/completions failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as any;
    // Change proofs (if any) come back in response headers — settle the wallet.
    await this.opts.payment.settle(res.headers);
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
}

/**
 * Discover Routstr nodes from kind-38421 provider announcements (`u` endpoint
 * tags, `mint` tags). Returns endpoint URLs; the operator/daemon picks one.
 */
export function parseProviderAnnouncement(event: { tags: string[][] }): {
  endpoints: string[];
  mints: string[];
} {
  const endpoints = event.tags.filter((t) => t[0] === "u").map((t) => t[1]!).filter(Boolean);
  const mints = event.tags.filter((t) => t[0] === "mint").map((t) => t[1]!).filter(Boolean);
  return { endpoints, mints };
}
