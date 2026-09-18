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
import {
  parseModelJson,
  PROVIDER_TIMEOUTS,
  providerHttpError,
  readJsonCapped,
  withProviderTimeout,
  withUncancellableDeadline,
} from "./http.js";
import { guardedProviderFetch, type ProviderNetPolicy } from "../net/safe-fetch.js";

export interface RoutstrOptions {
  nodeUrl: string; // e.g. https://api.routstr.com/v1
  payment: PaymentStrategy; // CashuPayment (or ApiKeyPayment for a balance key)
  /** DNS-pinning policy for outbound requests (audit R22). Default: pin + public-only. */
  net?: ProviderNetPolicy;
}

export class RoutstrLlm implements LlmProvider {
  readonly id = "routstr";
  constructor(private readonly opts: RoutstrOptions) {}

  private base(): string {
    return this.opts.nodeUrl.replace(/\/+$/, "");
  }

  async models(): Promise<ModelInfo[]> {
    const body = await withProviderTimeout(
      "Routstr GET /models",
      PROVIDER_TIMEOUTS.metadata,
      (signal) =>
        // Byte-capped body reads throughout this adapter, not just deadline-bounded
        // ones: a Routstr node is DISCOVERED from an untrusted kind-38421
        // announcement, so the operator never chose the host these bytes come from,
        // and an unbounded `res.json()` inside the 120s completion deadline is an
        // OOM of the single-threaded daemon (see PROVIDER_BODY_LIMITS).
        guardedProviderFetch(`${this.base()}/models`, { signal }, this.opts.net ?? {}, async (res) => {
          if (!res.ok) throw await providerHttpError(res, "Routstr GET /models");
          return await readJsonCapped<{ data?: any[] }>(res, "Routstr GET /models");
        }),
    );
    return (body.data ?? []).map((m) => ({
      id: m.id,
      contextLength: m.context_length,
      supportsResponseSchema: m.supports_response_schema ?? false,
      satsPricing: m.sats_pricing,
    }));
  }

  /** Accepted mints etc. from the node's /v1/info (spec §9.4). */
  async info(): Promise<any> {
    return withProviderTimeout("Routstr GET /info", PROVIDER_TIMEOUTS.metadata, (signal) =>
      guardedProviderFetch(`${this.base()}/info`, { signal }, this.opts.net ?? {}, async (res) =>
        res.ok ? await readJsonCapped(res, "Routstr GET /info") : {},
      ),
    );
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
    // prepare() runs BEFORE the completion deadline is armed and takes no signal —
    // a CashuPayment whose mint stops answering would otherwise park the serial job
    // loop forever with nothing logged. Bounded so the worst case is a failed job.
    const headers = {
      "Content-Type": "application/json",
      ...(await withUncancellableDeadline("Routstr payment.prepare", PROVIDER_TIMEOUTS.payment, () =>
        this.opts.payment.prepare({ estimateTokens: req.maxTokens }),
      )),
    };
    let body: any;
    try {
      body = await withProviderTimeout(
        "Routstr chat/completions",
        PROVIDER_TIMEOUTS.completion,
        (signal) =>
          guardedProviderFetch(
            `${this.base()}/chat/completions`,
            {
              method: "POST",
              headers,
              signal,
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
            },
            this.opts.net ?? {},
            async (res) => {
              if (!res.ok) {
                throw await providerHttpError(res, "Routstr chat/completions");
              }
              const parsed = await readJsonCapped<any>(res, "Routstr chat/completions");
              // Change proofs (if any) come back in response headers — settle the wallet.
              await this.opts.payment.settle(res.headers);
              return parsed;
            },
          ),
        req.signal,
      );
    } catch (e) {
      // Network failure / non-2xx / TIMEOUT after prepare(): the reserved proofs
      // never reach a settle() — account for them, and after a post-reservation
      // timeout the mint state is genuinely ambiguous (audit COORD-5, H-4).
      await this.opts.payment.fail?.().catch(() => {});
      throw e;
    }
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new ProviderContractError(this.id, req.schemaName, req.model, "no string content");
    }
    // Both of these landed on the Venice path (PIPE-1, PIPE-13) and not here, and
    // Routstr routes to the SAME open-weight models over the same OpenAI-compatible
    // shape, so both failures are equally reachable through it.
    //
    // A response cut off at the token ceiling is unparseable JSON, and without this
    // it is indistinguishable in the logs from a model that emitted garbage — the
    // two want opposite responses (raise the budget vs. fix the prompt). Checked
    // BEFORE the parse so the diagnosis survives a truncation that happens to land
    // on a syntactically complete prefix.
    const finish = body.choices?.[0]?.finish_reason;
    if (finish === "length") {
      throw new ProviderContractError(
        this.id,
        req.schemaName,
        req.model,
        `response truncated at the ${req.maxTokens ?? 4096}-token ceiling (finish_reason=length)`,
      );
    }
    let parsed: unknown;
    try {
      // Lenient only in the ways a model actually malforms JSON — a ```json fence,
      // a leading sentence. A bare JSON.parse is what makes MODEL-BAKEOFF.md's
      // quality-and-cost winner unadoptable: it fences its output despite
      // `strict: true`, so it fails almost every production call while
      // benchmarking at zero format failures.
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
      usage: {
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
        totalTokens: body.usage?.total_tokens ?? 0,
        // Same OpenAI-shaped field Venice reports; surfaced here too so a
        // reasoning model routed through Routstr does not quietly lose the one
        // number that explains its cost per call (see TokenUsage).
        reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
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
