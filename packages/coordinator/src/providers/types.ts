/**
 * Provider abstraction (spec §9.4). ALL AI I/O goes through these three
 * interfaces; nothing else in the coordinator may import an HTTP client for AI.
 * This is the Routstr-readiness requirement: swapping Venice → Routstr is a new
 * adapter, not a code change elsewhere.
 */

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
  }): Promise<{ value: T; usage: TokenUsage }>;
  embed?(texts: string[], model?: string): Promise<number[][]>; // optional capability
}

export interface PaymentStrategy {
  // orthogonal to providers
  prepare(req: { estimateTokens?: number }): Promise<Record<string, string>>; // → HTTP headers
  settle(responseHeaders: Headers): Promise<void>; // e.g. bank Cashu change
}

/** Which provider + model to use for a given role (spec §9.4 model routing). */
export interface ModelRef {
  provider: string;
  model: string;
}
