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
  /**
   * Of `completionTokens`, how many went on chain-of-thought (absent when the
   * provider does not say). Reported separately because it is otherwise invisible
   * — `strip_thinking_response` removes the reasoning TEXT but not the charge for
   * it — and a model that reasons 6000 tokens per call is dear per call however
   * cheap it is per token. Not an extra charge on top of `completionTokens`: on
   * Venice it is a subset of it (verified 2026-09-14).
   */
  reasoningTokens?: number;
}

/**
 * A typed question for a DECISION model (Venice `POST /decisions`, TypeSafe's
 * "System One" class — `jev-latest`). A decision model does not generate text:
 * it evaluates one `state` against a map of questions and returns calibrated
 * probabilities, which is what a scorer actually needs.
 *
 * Every question in a request is evaluated independently against the same state,
 * so the state is billed once however many questions ride on it. Question ids
 * are chosen by the caller and are NOT shown to the model.
 *
 * `instructions` may be a string or a JSON value; nostrautica sends an object so
 * a candidate's profile can ride INSIDE its own question rather than in the
 * shared state. That placement is load-bearing: several questions over one state
 * are independent (measured agreement with one-question-per-request: Spearman
 * 0.999), while several ITEMS inside one state leak into each other's scores
 * (cross-seed top-5 tau 0.63 vs 0.88). See docs/MATCHING-BENCHMARK.md.
 */
export type DecisionQuestion =
  | { type: "noul"; instructions: unknown; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, string | null> }
  | { type: "score"; instructions: unknown; criteria: readonly string[] };

/** P(yes) in [0,1]. No separate confidence: 0.5 IS the uncertain answer. */
export interface DecisionNoulAnswer {
  type: "noul";
  noul: number;
}
export interface DecisionChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
/**
 * `score` is the probability-weighted level index (0 … criteria.length−1) and can
 * land between levels. `probabilities` is the real output — the scalar is a
 * convenience over it — so callers that may want to re-threshold later should
 * persist the distribution rather than just the number.
 */
export interface DecisionScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}
export type DecisionAnswer = DecisionNoulAnswer | DecisionChoiceAnswer | DecisionScoreAnswer;

export interface SttProvider {
  readonly id: string; // "venice-stt" | "local-whisper"
  capabilities(): Promise<{ models: string[]; maxUploadBytes: number }>;
  transcribe(
    audio: { data: Uint8Array; mime: string; language?: string },
    /** `signal` (audit R13): caller cancellation (shutdown / per-event teardown),
     *  combined with the adapter's own STT deadline so a blocked upload unwinds. */
    opts?: { model?: string; signal?: AbortSignal },
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
    /** Caller cancellation (audit R13): shutdown / per-event teardown, combined with
     *  the adapter's own completion deadline via `AbortSignal.any()`. */
    signal?: AbortSignal;
  }): Promise<{ value: T; usage: TokenUsage }>;
  embed?(texts: string[], model?: string, signal?: AbortSignal): Promise<number[][]>; // optional capability (R13 signal)
  /**
   * Evaluate a state against typed questions on a DECISION model — optional,
   * exactly like {@link embed}: a provider that has no decision endpoint simply
   * does not implement it, and `resolveRoleRoutes` refuses to route a decision
   * role at a provider that lacks it rather than failing at the first call.
   *
   * Returns one answer per question id. Usage is input-only on Venice (output
   * tokens are reported but priced at zero), so `completionTokens` is carried
   * through as reported rather than being zeroed — a cost table decides what to
   * charge for it, not the adapter.
   */
  decide?(req: {
    state: unknown;
    questions: Record<string, DecisionQuestion>;
    model: string;
    /** Runtime validator, as in {@link completeStructured} (audit Q9). */
    validate?: (raw: unknown) => unknown;
    signal?: AbortSignal;
  }): Promise<{ answers: Record<string, DecisionAnswer>; usage: TokenUsage }>;
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

/** The matching-pipeline roles that route to an LLM provider (spec §13.5 / H-1). */
export type MatchRole = "summary" | "match" | "embed" | "translate";
/**
 * Roles that exist only when the operator configures them. `match_score` routes
 * pair SCORING to a decision model while `match` keeps writing the prose; absent,
 * `match` does both, exactly as it always has.
 */
export type OptionalMatchRole = "match_score";

/**
 * A fully-RESOLVED provider route for one role (H-1, §13.5 Option A): the concrete
 * provider INSTANCE that will serve this role, its model, the provider's id, the
 * effective private-tier requirement, and the privacy tier VERIFIED at startup from
 * the provider's own model catalogue. The public 31611 announcement's privacy map is
 * generated from `privacy` here — where data actually flows — not from config intent.
 * Cache keys that must invalidate on a provider/model change use `provider:model`.
 */
export interface RoleRoute {
  llm: LlmProvider;
  model: string;
  /** Provider instance id, e.g. "venice" | "routstr". */
  provider: string;
  requirePrivate: boolean;
  /** Verified at startup from the provider catalogue; falls back to intent when a
   *  model can't be found in the catalogue (e.g. embeddings on a separate endpoint). */
  privacy: "private" | "non-private";
}

/** Per-role resolved routes threaded through the whole matching pipeline (H-1). */
export type RoleRoutes = Record<MatchRole, RoleRoute> &
  Partial<Record<OptionalMatchRole, RoleRoute>>;
