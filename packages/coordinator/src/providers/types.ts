/**
 * Provider abstraction (spec §9.4). ALL AI I/O goes through these three
 * interfaces; nothing else in the coordinator may import an HTTP client for AI.
 * This is the Routstr-readiness requirement: swapping Venice → Routstr is a new
 * adapter, not a code change elsewhere.
 */
import { ZodError } from "zod";

/**
 * A provider returned output that doesn't satisfy the expected response contract
 * (audit finding Q9): non-JSON, missing/extra fields, wrong types, NaN/out-of-range
 * values. Thrown from the provider boundary so malformed output is treated exactly
 * like any other provider failure — the job runner retries with backoff and poisons
 * after the attempt cap, instead of letting bad data reach storage or publication.
 *
 * The message carries only provider/model/schema identity plus validation *paths*
 * (never the prompt or attendee text) so poison diagnostics stay sanitized.
 */
export class ProviderContractError extends Error {
  constructor(
    readonly provider: string,
    readonly schemaName: string,
    readonly model: string,
    readonly detail: string,
  ) {
    super(
      `provider ${provider} output failed the ${schemaName} contract (model ${model}): ${detail}`,
    );
    this.name = "ProviderContractError";
  }
}

/** Sanitized one-line summary of a validation failure (paths + codes only). */
export function contractFailureDetail(e: unknown): string {
  if (e instanceof ZodError) {
    return e.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`)
      .join("; ")
      .slice(0, 300);
  }
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

/**
 * Validate a provider's already-JSON-parsed output at the boundary. `validate`
 * is a zod `.parse` (or any throwing validator); on failure this raises a
 * sanitized {@link ProviderContractError}. Adapters call this so every LLM
 * response is schema-checked before it's trusted.
 */
export function validateProviderValue<T>(
  raw: unknown,
  meta: { provider: string; schemaName: string; model: string },
  validate?: (raw: unknown) => T,
): T {
  if (!validate) return raw as T;
  try {
    return validate(raw);
  } catch (e) {
    throw new ProviderContractError(
      meta.provider,
      meta.schemaName,
      meta.model,
      contractFailureDetail(e),
    );
  }
}

export interface ModelInfo {
  id: string;
  contextLength?: number;
  supportsResponseSchema?: boolean;
  /** Provider-specific privacy flag (Venice private/TEE tiers). */
  private?: boolean;
  /** Routstr sats pricing, when present. */
  satsPricing?: unknown;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SttProvider {
  readonly id: string; // "venice-stt" | "local-whisper"
  capabilities(): Promise<{ models: string[]; maxUploadBytes: number }>;
  transcribe(
    audio: { data: Uint8Array; mime: string; language?: string },
    opts?: { model?: string },
  ): Promise<{ text: string; language?: string }>;
}

export interface LlmProvider {
  readonly id: string; // "venice" | "routstr"
  models(): Promise<ModelInfo[]>; // always queried at runtime
  completeStructured<T>(req: {
    system: string;
    user: string;
    schema: object;
    schemaName: string; // json_schema strict mode
    model: string;
    temperature?: number;
    maxTokens?: number;
    /**
     * Runtime validator for the model's JSON output (audit Q9). When present the
     * adapter runs it after JSON.parse and raises a {@link ProviderContractError}
     * on failure, so malformed output never leaves the provider boundary as a
     * trusted value. Typically a zod schema's `.parse`.
     */
    validate?: (raw: unknown) => T;
  }): Promise<{ value: T; usage: TokenUsage }>;
  embed?(texts: string[], model?: string): Promise<number[][]>; // optional capability
}

export interface PaymentStrategy {
  // orthogonal to providers
  prepare(req: { estimateTokens?: number }): Promise<Record<string, string>>; // → HTTP headers
  settle(responseHeaders: Headers): Promise<void>; // e.g. bank Cashu change
  /**
   * The request FAILED after prepare() (network error, non-2xx) so settle() will
   * never run (audit COORD-5): the strategy must account for the reserved proofs —
   * re-credit them or quarantine the reservation as ambiguous for reconcile.
   */
  fail?(): Promise<void>;
}

/** Which provider + model to use for a given role (spec §9.4 model routing). */
export interface ModelRef {
  provider: string;
  model: string;
}
