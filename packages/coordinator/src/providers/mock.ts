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
} from "./types.js";

export class MockStt implements SttProvider {
  readonly id = "mock-stt";
  calls = 0;
  constructor(private readonly transcripts: Record<string, string> = {}) {}

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
  readonly id = "mock";
  completeCalls = 0;
  embedCalls = 0;
  constructor(
    private readonly handler: (req: { system: string; user: string; schemaName: string }) => unknown,
  ) {}

  async models(): Promise<ModelInfo[]> {
    return [
      { id: "mock-strong", supportsResponseSchema: true, private: true },
      { id: "mock-cheap", supportsResponseSchema: true, private: true },
      { id: "mock-embed", private: true },
    ];
  }

  async completeStructured<T>(req: {
    system: string;
    user: string;
    schema: object;
    schemaName: string;
    model: string;
  }): Promise<{ value: T; usage: TokenUsage }> {
    this.completeCalls++;
    return {
      value: this.handler(req) as T,
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
