/**
 * Mock providers for tests (spec §9.4: "the provider interfaces make mocks
 * first-class"). Each counts its calls so tests can assert idempotency — a
 * restart must never re-bill (IMPLEMENTATION_PLAN §3.11, P4 acceptance).
 */
import type {
  SttProvider,
  LlmProvider,
  ModelInfo,
  TokenUsage,
  DecisionAnswer,
  DecisionQuestion,
} from "./types.js";
import { validateProviderValue } from "./types.js";

export class MockStt implements SttProvider {
  readonly id = "mock-stt";
  calls = 0;
  constructor(private readonly transcripts: Record<string, string> = {}) {}

  /** Register a transcript for a given blob byte-length (tests: a new recording). */
  setTranscript(sizeKey: string, text: string): void {
    this.transcripts[sizeKey] = text;
  }

  async capabilities() {
    return { models: ["mock"], maxUploadBytes: 25 * 1024 * 1024 };
  }

  async transcribe(audio: { data: Uint8Array; mime: string }) {
    this.calls++;
    // Deterministic: key by a short hash of the bytes, else a default.
    const key = `${audio.data.length}`;
    return { text: this.transcripts[key] ?? this.transcripts.default ?? "mock transcript" };
  }
}

export class MockLlm implements LlmProvider {
  readonly id: string;
  completeCalls = 0;
  embedCalls = 0;
  decideCalls = 0;
  /** Present only when the fake was given a decision handler (see constructor). */
  decide?: (req: {
    state: unknown;
    questions: Record<string, DecisionQuestion>;
    model: string;
  }) => Promise<{ answers: Record<string, DecisionAnswer>; usage: TokenUsage }>;
  /** Every decide() request seen, for shape assertions in tests. */
  decisions: { state: unknown; questions: Record<string, DecisionQuestion>; model: string }[] = [];
  /** Every completeStructured request seen, for prompt assertions in tests. */
  requests: { system: string; user: string; schemaName: string }[] = [];
  private readonly catalogue: ModelInfo[];
  private readonly modelsError?: () => never;
  private readonly decider?: (req: {
    state: unknown;
    questions: Record<string, DecisionQuestion>;
    model: string;
  }) => Record<string, DecisionAnswer>;
  constructor(
    private readonly handler: (req: { system: string; user: string; schemaName: string }) => unknown,
    /** Per-role routing tests (audit H-1): give a fake a distinct id, catalogue, or
     *  a models() that throws (to simulate a one-provider outage). */
    opts: {
      id?: string;
      models?: ModelInfo[];
      modelsThrows?: boolean;
      /** Supply a decision handler to make this fake a DECISION provider too.
       *  Absent, `decide` is undefined — which is what `resolveRoleRoutes` checks
       *  when it refuses to route models.match_score at a provider without one. */
      decide?: (req: {
        state: unknown;
        questions: Record<string, DecisionQuestion>;
        model: string;
      }) => Record<string, DecisionAnswer>;
    } = {},
  ) {
    this.decider = opts.decide;
    // Attached as an OWN property only when a decider was supplied, never as a
    // class method: `decide` is OPTIONAL on LlmProvider and `typeof llm.decide
    // === "function"` is the production capability probe. A prototype method
    // would answer that probe on every fake — including the ones written to
    // prove startup fails closed on a provider that has no decision endpoint,
    // which is precisely the check that would then be testing nothing. (A
    // `delete this.decide` does not help: it removes an own property, and a
    // class method is not one.)
    if (opts.decide) {
      this.decide = async (req: {
        state: unknown;
        questions: Record<string, DecisionQuestion>;
        model: string;
      }): Promise<{ answers: Record<string, DecisionAnswer>; usage: TokenUsage }> => {
        this.decideCalls++;
        this.decisions.push({ state: req.state, questions: req.questions, model: req.model });
        return {
          answers: this.decider!(req),
          // Input-only billing, as on Venice: output tokens are reported and free.
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        };
      };
    }
    this.id = opts.id ?? "mock";
    this.catalogue = opts.models ?? [
      { id: "mock-strong", supportsResponseSchema: true, private: true },
      { id: "mock-cheap", supportsResponseSchema: true, private: true },
      { id: "mock-embed", private: true },
    ];
    if (opts.modelsThrows) {
      this.modelsError = () => {
        throw new Error(`${this.id} catalogue unreachable`);
      };
    }
  }

  /** The most recent request for a given schemaName (test helper). */
  lastBySchema(schemaName: string) {
    return [...this.requests].reverse().find((r) => r.schemaName === schemaName);
  }

  async models(): Promise<ModelInfo[]> {
    if (this.modelsError) this.modelsError();
    return this.catalogue;
  }

  async completeStructured<T>(req: {
    system: string;
    user: string;
    schema: object;
    schemaName: string;
    model: string;
    validate?: (raw: unknown) => T;
  }): Promise<{ value: T; usage: TokenUsage }> {
    this.completeCalls++;
    this.requests.push({ system: req.system, user: req.user, schemaName: req.schemaName });
    // Run mock output through the same contract validation as real providers
    // (audit Q9: "validate mock provider output too so tests exercise the contract").
    return {
      value: validateProviderValue<T>(
        this.handler(req),
        { provider: this.id, schemaName: req.schemaName, model: req.model ?? "mock" },
        req.validate,
      ),
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.embedCalls++;
    // Deterministic pseudo-embedding: char-code buckets, L2-normalized.
    return texts.map((t) => {
      const v = new Array(8).fill(0);
      for (let i = 0; i < t.length; i++) v[i % 8] += t.charCodeAt(i);
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}
